/**
 * Command-target analysis, the mechanism half of the ephemeral-target exemption.
 *
 * This file tests `command-targets.ts` against a *representative* root list of its own. The real
 * catalogue lives in `core.ts` and the composed rule decisions are asserted in `test/core.test.ts`;
 * keeping the two apart means a policy change (a root added) and a mechanism change (a tokenizer
 * gap) fail in different files.
 *
 * **Every row here asserts a fail-safe direction.** The exemption can only ever *skip* a rule that
 * already matched, so a mistake in the confining direction is an extra prompt and a mistake in the
 * other direction is a `rm -rf /` that runs with no prompt at all. The `FAIL-OPEN GUARDS` block is
 * the set of spellings a plausible, simpler implementation of this module gets wrong — each was
 * verified to reach the rule pattern in `core.ts` while a tokenizer-shaped check called it
 * confined. A later "simplification" that flips one of those rows to `true` has reintroduced a
 * silent hole, which is why they are rows and not comments.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalizeLiteralOperand,
	findInvocationOperands,
	hasOnlyExemptTargets,
	isWithinRoot,
	splitCommandStatements,
} from "../command-targets.ts";

// A stand-in for core.ts's EPHEMERAL_TARGET_ROOTS. Deliberately a copy rather than an import: this
// file tests the mechanism, and it should keep passing when the policy catalogue changes.
const ROOTS = ["/tmp/", "/private/tmp/", "/var/tmp/", "/private/var/tmp/", "/var/folders/", "/private/var/folders/"];

function isEphemeralTarget(operand: string): boolean {
	const canonical = canonicalizeLiteralOperand(operand);
	return canonical !== undefined && ROOTS.some((root) => isWithinRoot(canonical, root, true));
}

function confinesRmTo(command: string): boolean {
	return hasOnlyExemptTargets(command, "rm", isEphemeralTarget);
}

interface TargetCase {
	command: string;
	confined: boolean;
	why: string;
}

const CASES: readonly TargetCase[] = [
	// ── Confined: the shapes this exemption exists for ────────────────────────────────────────
	{ command: "rm -rf /tmp/scratch", confined: true, why: "a literal segment below an ephemeral root" },
	{ command: "rm -rf /var/folders/ab/cd/T/x", confined: true, why: "an expanded macOS $TMPDIR" },
	{ command: "cd /repo; rm -rf /tmp/x", confined: true, why: "statement split: only the rm is judged" },
	{ command: "/bin/rm -rf /tmp/x", confined: true, why: "a path-qualified command word is still rm" },
	{ command: "\\rm -rf /tmp/x", confined: true, why: "a backslash-escaped command word is still rm" },
	{ command: "sudo rm -rf /tmp/x", confined: true, why: "the removal is confined; sudo is a separate rule" },
	{
		command: "set -e\nrm -rf /tmp/x\npython3 -m venv /tmp/x",
		confined: true,
		why: "a newline is a statement separator, not whitespace",
	},
	{ command: "rm -rf /tmp/scratch/*", confined: true, why: "a wildcard below a literal segment" },
	{ command: "rm -rf /tmp//x", confined: true, why: "repeated slashes collapse" },
	{ command: "rm -rf /tmp/x/", confined: true, why: "a trailing slash names the same directory" },
	{ command: "rm -rf /tmp/x/.cache", confined: true, why: "a dot-prefixed name is an ordinary name" },
	{ command: "rm -rf /private/tmp/claude-501/session/scratchpad", confined: true, why: "the macOS /tmp target" },
	{
		command: "rm -rf --no-preserve-root /tmp/x",
		confined: true,
		why: "flags are dropped here; core.ts refuses to exempt this one anyway",
	},

	// ── Not confined: the root itself, or something outside it ────────────────────────────────
	{ command: "rm -rf /tmp", confined: false, why: "the root itself, not something under it" },
	{ command: "rm -rf /tmp/", confined: false, why: "still the root itself" },
	{ command: "rm -rf /tmp/*", confined: false, why: "a wildcard at the root wipes other processes' state" },
	{ command: "rm -rf /tmp/../src", confined: false, why: "a literal .. disqualifies the operand" },
	{ command: "rm -rf /tmp/.", confined: false, why: "a . as a whole segment is the root again" },
	{ command: "rm -rf /tmp/x{,/../../etc}", confined: false, why: "brace expansion is not a literal path" },
	{ command: "rm -rf /tmp/scratch dist", confined: false, why: "a second operand is outside" },
	{ command: "rm -rf /tmp/x /", confined: false, why: "/ is not ephemeral" },
	{ command: "rm -rf /tmp/x -- /etc", confined: false, why: "-- is dropped as a flag; /etc is not" },
	{ command: "rm -rf 'tmp/x' ~/.ssh", confined: false, why: "~ is not an ephemeral root" },
	{ command: "rm -rf scratch", confined: false, why: "relative: it resolves against the repository" },
	{ command: "rm -rf /tmp/x && rm -rf dist", confined: false, why: "a second invocation is not confined" },
	{ command: "rm -rf /tmp/x #cleanup", confined: false, why: "a trailing comment reads as an operand" },
	{ command: 'rm -rf "/tmp/a b"', confined: false, why: "a quoted space tokenizes into two operands" },
	{ command: "rm -rf /TMP/x", confined: false, why: "root matching is case-sensitive, deliberately" },

	// ── FAIL-OPEN GUARDS ─────────────────────────────────────────────────────────────────────
	// Each of these reaches the rule pattern in core.ts, and each is confined-looking to a
	// tokenizer that stops one step short. Flipping any row to `true` is a silent `rm -rf /`.
	{
		command: "rm -rf /tmp/x && /bin/rm -rf /",
		confined: false,
		why: "an unrecognised command spelling would leave the second statement invisible",
	},
	{
		command: "rm -rf /tmp/x && \\rm -rf /",
		confined: false,
		why: "same, via the alias-suppressing backslash",
	},
	{
		command: "rm -rf /tmp/x && echo / | xargs rm -rf",
		confined: false,
		why: "an invocation with no operands takes them from stdin; [].every() is vacuously true",
	},
	{
		command: "find / -name .git -print0 | xargs -0 rm -rf",
		confined: false,
		why: "the same vacuous truth, without a benign statement to hide behind",
	},
	{ command: 'rm -rf "$TMPDIR/build"', confined: false, why: "a variable is not a literal root" },
	{
		command: 'TMPDIR=/ rm -rf "$TMPDIR/etc"',
		confined: false,
		why: "the same command can set TMPDIR, so trusting the name is self-defeating",
	},
	{
		command: "rm -rf /tmp/x/$DIR",
		confined: false,
		why: "an expansion below a literal segment is still an expansion",
	},
	{
		command: "DIR='.. /'; rm -rf /tmp/x/$DIR",
		confined: false,
		why: "word splitting turns one visible operand into two, one of them /",
	},
	{
		command: "rm -rf /tmp/x/\\.\\./\\.\\./etc",
		confined: false,
		why: "escaped dots are .. to the shell and not to a substring test",
	},
	{ command: "rm -rf $'/tmp/x\\x2f..'", confined: false, why: "an ANSI-C quoted operand is not a literal" },
	{ command: 'rm -rf "/tmp/x"/../../etc', confined: false, why: "quotes in the middle, not around" },
	{ command: "rm -rf /tmpdata/prod", confined: false, why: "a root prefix is not a root without the separator" },
	{ command: "rm -rf /var/folders-backup/prod", confined: false, why: "the same, one directory up" },
	{ command: `rm -rf \${TMPDIR}x`, confined: false, why: "a braced expansion is not a literal" },
	{ command: "rm -rf $TMPDIRx/y", confined: false, why: "a longer variable name that merely starts the same" },
	{ command: 'rm -rf "/tmp/$(cat x)"', confined: false, why: "command substitution" },
	{ command: "rm -rf /tmp/x $(pwd)", confined: false, why: "command substitution as a second operand" },
	{ command: "rm -rf /tmp/x `echo y`", confined: false, why: "backtick substitution" },
	{ command: "rm -rf /tmp/x /tmp/../y", confined: false, why: "one confined operand does not carry the other" },
	{ command: "eval 'rm -rf /'", confined: false, why: "no invocation is recognised, so nothing is exempted" },
	{ command: 'bash -c "rm -rf /"', confined: false, why: "the same, through a quoted -c argument" },
	{ command: "for d in /tmp/a; do rm -rf $d; done", confined: false, why: "the loop variable is an expansion" },
	{ command: "IFS=/; rm -rf $p", confined: false, why: "an expansion whose splitting the caller controls" },
];

test("decides confinement for every command shape, in the fail-safe direction", () => {
	// Guards against a row silently disappearing from the table during a refactor.
	assert.equal(CASES.length, 51);

	for (const { command, confined, why } of CASES) {
		assert.equal(confinesRmTo(command), confined, `${why} — command: ${JSON.stringify(command)}`);
	}
});

test("splits on every separator that starts a new statement", () => {
	assert.deepEqual(splitCommandStatements("a && b || c | d & e ; f\ng"), ["a", "b", "c", "d", "e", "f", "g"]);
	assert.deepEqual(splitCommandStatements("   "), []);
	assert.deepEqual(splitCommandStatements("rm -rf /tmp/x"), ["rm -rf /tmp/x"]);
});

test("returns one operand list per invocation, and an empty list is not no invocation", () => {
	assert.deepEqual(findInvocationOperands("rm -rf /tmp/a /tmp/b", "rm"), [["/tmp/a", "/tmp/b"]]);
	assert.deepEqual(findInvocationOperands("xargs rm -rf", "rm"), [[]]);
	assert.deepEqual(findInvocationOperands("rm -rf a rm -rf b", "rm"), [["a"], ["b"]]);
	assert.deepEqual(findInvocationOperands("/usr/bin/rm -rf a", "rm"), [["a"]]);
	assert.deepEqual(findInvocationOperands("ls -la /tmp", "rm"), []);
	// A quoted command word is not an invocation this module claims to understand.
	assert.deepEqual(findInvocationOperands('bash -c "rm -rf /"', "rm"), []);
});

test("canonicalizes only operands the shell passes through untouched", () => {
	assert.equal(canonicalizeLiteralOperand("/tmp//x/"), "/tmp/x/");
	assert.equal(canonicalizeLiteralOperand('"/tmp/x"'), "/tmp/x");
	assert.equal(canonicalizeLiteralOperand("'/tmp/x'"), "/tmp/x");
	assert.equal(canonicalizeLiteralOperand("/tmp/x/*"), "/tmp/x/*");

	for (const rejected of [
		"/tmp/$X",
		"/tmp/`x`",
		"/tmp/\\x",
		"/tmp/{a,b}",
		"~/x",
		"/tmp/x#y",
		'"/tmp/x',
		"/tmp/../y",
	]) {
		assert.equal(canonicalizeLiteralOperand(rejected), undefined, `must not canonicalize: ${rejected}`);
	}
});

test("requires a separator after the root, and a segment below it only when asked", () => {
	assert.equal(isWithinRoot("/tmp/x", "/tmp/", true), true);
	assert.equal(isWithinRoot("/tmp", "/tmp/", true), false);
	assert.equal(isWithinRoot("/tmp/", "/tmp/", true), false);
	assert.equal(isWithinRoot("/tmp/*", "/tmp/", true), false);
	assert.equal(isWithinRoot("/tmpdata/x", "/tmp/", true), false);

	// A session-granted root: the operand the user was shown, and anything below it.
	assert.equal(isWithinRoot("/Users/me/scratch/build", "/Users/me/scratch/build", false), true);
	assert.equal(isWithinRoot("/Users/me/scratch/build/sub", "/Users/me/scratch/build", false), true);
	assert.equal(isWithinRoot("/Users/me/scratch/other", "/Users/me/scratch/build", false), false);
	assert.equal(isWithinRoot("/Users/me/scratch", "/Users/me/scratch/build", false), false);
});
