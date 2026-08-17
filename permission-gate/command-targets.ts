/**
 * Which files a command's operands name — enough of it to answer one question:
 * *is every invocation of this command confined to a directory we do not care about?*
 *
 * **Security posture: this is mechanism for a guardrail, not a shell parser and not a security
 * boundary.** `core.ts` and `README.md` say the same sentence and it is the honest description of
 * what this can do. Everything here is a *narrowing* device: it decides whether a rule that has
 * already matched may be skipped. So the only failure that matters is the one where this says
 * "confined" about a command that is not, and every screen below is written to fail in the other
 * direction — an operand this module does not fully understand is never confined.
 *
 * That asymmetry is the whole design, and it is why the screens are an **allowlist**. A blacklist
 * of dangerous spellings quantified over a hand-rolled tokenizer fails open at every gap in the
 * tokenizer, and the gaps are not hypothetical: `\rm`, `/bin/rm`, `xargs rm -rf` with no operands
 * at all, `/tmp/x/\.\./\.\./etc` whose `..` survives a `includes("..")` test as `\.\.`, and
 * `DIR='.. /'; rm -rf /tmp/x/$DIR`, where one operand the tokenizer can see becomes two the shell
 * runs. Each of those turns a gated `rm -rf /` into silence. An operand must therefore *match* a
 * literal charset to be considered at all, rather than be screened for known-bad substrings.
 *
 * Pure by construction — imports nothing, like `core.ts`, so the whole thing is testable with no
 * temporary directory and no filesystem (S1, T7).
 *
 * Policy lives in `core.ts`: which roots count as throwaway, and what a session grant widens, are
 * both passed in as data or as a predicate (P3). This module knows only how to take a command
 * apart.
 *
 * ## What this intentionally does not cover
 *
 * Each of these is a decision, not an oversight (P3), and each fails in the safe direction —
 * an extra prompt, never a missing one.
 *
 * - **No symlink resolution, no `realpath`, no filesystem access.** `rm -rf /tmp/link-to-repo` is
 *   treated as confined to `/tmp`. The gate is a guardrail and `core.ts` touches no filesystem.
 * - **No variable expansion, and no trust in one either.** An operand containing `$` or a backtick
 *   is never confined, because an unquoted expansion changes the shell's *operand count*, not only
 *   an operand's value.
 * - **No flag arity.** A flag's separate value — the `0` of `truncate -s 0 /tmp/f` — is read as an
 *   operand, so it looks relative and nothing is exempted. That is why `filesystem-truncate` does
 *   not opt in; see the note next to it in `core.ts`.
 * - **No `cwd` awareness.** A relative operand is never confined.
 * - **No quoting model beyond one symmetric layer.** `"/tmp/a b"` tokenizes into two operands, one
 *   of which is relative, so nothing is exempted.
 * - **Case-sensitive root matching**, which is the deliberate *opposite* of `advisor`'s `P6`
 *   case-folding fix, for the reason recorded next to the root catalogue in `core.ts`.
 */

/**
 * Shell metacharacters that end one statement and begin another. Splitting on the single
 * characters covers the doubled operators too — `a && b` yields an empty middle piece that is
 * dropped — so there is one list rather than two that can disagree.
 *
 * A `&` inside a redirect (`2>&1`) splits a statement that was never an invocation, and a
 * metacharacter inside quotes splits an operand into pieces that fail the literal screen. Both
 * cost a prompt and neither can grant one.
 */
const STATEMENT_SEPARATOR_PATTERN = /[\n\r;|&]/;

/**
 * The only operand shape that can ever be considered confined: an unbroken run of characters that
 * the shell passes through untouched, plus `*`, which `filesystem-rm-wildcard` exists to gate and
 * which `isWithinRoot` handles positionally rather than by rejecting outright.
 *
 * Everything else — `$`, a backtick, `\`, `{`, `}`, `~`, `#`, a quote, whitespace, `(` — means the
 * string the shell acts on is not the string we are looking at, so we do not get to have an
 * opinion about it.
 */
const LITERAL_OPERAND_PATTERN = /^[A-Za-z0-9._+*/-]+$/;

/** Split a command into the statements the shell would run separately. */
export function splitCommandStatements(command: string): string[] {
	return command
		.split(STATEMENT_SEPARATOR_PATTERN)
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/**
 * The command a token invokes, ignoring the two ways of spelling the same one: a path prefix
 * (`/bin/rm`) and a backslash escape that suppresses alias lookup (`\rm`). Both reach the same
 * binary, and both are matched by the rule patterns in `core.ts`, so both have to be recognised
 * here — a spelling the rule sees and the tokenizer does not is exactly a fail-open.
 *
 * Deliberately case-sensitive: on a case-insensitive filesystem `RM` runs `rm`, but failing to
 * recognise it means nothing gets exempted, which is the safe direction.
 */
function invokedCommandWord(token: string): string {
	const unescaped = token.startsWith("\\") ? token.slice(1) : token;
	const lastSlash = unescaped.lastIndexOf("/");
	return lastSlash === -1 ? unescaped : unescaped.slice(lastSlash + 1);
}

/**
 * Every invocation of `commandName` in one statement, as its list of non-flag operands.
 *
 * One statement can invoke the same command more than once (`xargs rm -rf` after a `find`, or a
 * `--` separated pair), so this returns one entry per invocation rather than one per statement.
 * An empty list is meaningful and is *not* the same as no invocation: `xargs rm -rf` takes its
 * targets from stdin, and treating "no operands" as "no dangerous operands" is how a
 * universally-quantified check gets satisfied by vacuous truth.
 */
export function findInvocationOperands(statement: string, commandName: string): string[][] {
	const tokens = statement.split(/\s+/).filter(Boolean);
	const sites: number[] = [];

	for (const [index, token] of tokens.entries()) {
		if (invokedCommandWord(token) === commandName) sites.push(index);
	}

	return sites.map((site, order) => {
		const end = sites[order + 1] ?? tokens.length;
		return tokens.slice(site + 1, end).filter((token) => !token.startsWith("-"));
	});
}

/**
 * The operand as a path, or `undefined` if it is not one we are willing to reason about.
 *
 * Returning a canonical string rather than a boolean is deliberate: the caller needs the collapsed
 * form to compare against a root, and producing it here means the screening and the comparison
 * cannot end up looking at two different spellings of the same operand (P6).
 */
export function canonicalizeLiteralOperand(operand: string): string | undefined {
	const unquoted = stripOneQuoteLayer(operand);
	if (!LITERAL_OPERAND_PATTERN.test(unquoted)) return undefined;

	const collapsed = unquoted.replace(/\/{2,}/g, "/");
	// `..` anywhere, not `..` as a segment: `/tmp/x{,/../../etc}` is rejected by the charset
	// already, and the stricter reading costs only a prompt on a path with a `..` inside a name.
	if (collapsed.includes("..")) return undefined;
	if (collapsed.split("/").includes(".")) return undefined;

	return collapsed;
}

function stripOneQuoteLayer(operand: string): string {
	const first = operand.at(0);
	if ((first === "'" || first === '"') && operand.length >= 2 && operand.at(-1) === first) {
		return operand.slice(1, -1);
	}
	return operand;
}

/**
 * Whether a canonical operand names something inside `root`.
 *
 * `requireSegmentBelow` is the difference between the two kinds of root this gate has, and it is
 * load-bearing in both directions:
 *
 * - A built-in throwaway root requires it, so `rm -rf /tmp` and `rm -rf /tmp/*` stay gated. They
 *   wipe every other process's scratch state, which is a different act from removing one's own
 *   directory under it. A first path segment containing `*` is not a segment for this purpose.
 * - A root the user granted for the session does not, because the thing they were shown and
 *   approved was that exact directory.
 *
 * The comparison is against `root` plus a separator, never a bare prefix: `/tmpdata/prod` starts
 * with `/tmp` and has nothing to do with it.
 */
export function isWithinRoot(canonicalOperand: string, root: string, requireSegmentBelow: boolean): boolean {
	const base = root.replace(/\/+$/, "");
	if (canonicalOperand === base) return !requireSegmentBelow;
	if (!canonicalOperand.startsWith(`${base}/`)) return false;

	const below = canonicalOperand
		.slice(base.length + 1)
		.split("/")
		.filter(Boolean);
	if (below.length === 0) return !requireSegmentBelow;

	return requireSegmentBelow ? !below[0]!.includes("*") : true;
}

/**
 * Whether **every** invocation of `commandName` in this command targets only paths the caller's
 * predicate accepts.
 *
 * Three ways this deliberately says `false`, each of which a plainer reading of "all operands are
 * safe" gets wrong:
 *
 * - **No invocation was recognised at all.** The rule matched the command, so the command word is
 *   in there somewhere — inside quotes, behind an `eval`, spelled in a way `invokedCommandWord`
 *   does not know. Not understanding the command is not a reason to skip a rule.
 * - **An invocation has no operands.** See `findInvocationOperands`.
 * - **Any single operand is rejected.** One `rm -rf /` in a compound is the whole command.
 */
export function hasOnlyExemptTargets(
	command: string,
	commandName: string,
	isExemptTarget: (operand: string) => boolean,
): boolean {
	const invocations = splitCommandStatements(command).flatMap((statement) =>
		findInvocationOperands(statement, commandName),
	);

	if (invocations.length === 0) return false;

	return invocations.every((operands) => operands.length > 0 && operands.every(isExemptTarget));
}
