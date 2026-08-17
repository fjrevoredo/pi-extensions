/**
 * Permission gate core helpers.
 *
 * This module is the single source of truth for permission-gate policy:
 * - ordered rule catalogue
 * - command normalization
 * - rule evaluation
 * - session approval key generation
 * - compact formatting helpers used by the extension entrypoint
 *
 * Keep this module independent from pi so the policy contract can be tested with no
 * TUI and no pi runtime. It imports nothing but `command-targets.ts`, which is pure for
 * the same reason and holds mechanism only — every question of *which* directory is
 * throwaway is answered here, so policy still lives in one module (P3).
 *
 * Rule order is significant: evaluation is first-match-wins, so earlier rules take
 * precedence over later ones when a command matches multiple patterns.
 */

import {
	canonicalizeLiteralOperand,
	findInvocationOperands,
	hasOnlyExemptTargets,
	isWithinRoot,
	splitCommandStatements,
} from "./command-targets.ts";

export const COMMAND_PREVIEW_MAX_LENGTH = 120;

export type PermissionGateRuleCategory =
	| "filesystem"
	| "process"
	| "package-manager"
	| "container"
	| "database"
	| "git"
	| "privilege"
	| "system"
	| "infrastructure";

export interface PermissionGateRule {
	id: string;
	label: string;
	category: PermissionGateRuleCategory;
	pattern: RegExp;
	/**
	 * Opt this rule into the ephemeral-target exemption, naming the command whose operands decide
	 * it. A rule with a `targetScope` is **skipped** when every invocation of that command is
	 * confined to a throwaway directory — and evaluation then *continues with the remaining rules*
	 * rather than allowing the command. That is what keeps `sudo rm -rf /tmp/x` gated: the removal
	 * rule steps aside and `privilege-sudo` matches instead.
	 *
	 * Only add this where the operands really are the whole risk. See the notes next to
	 * `filesystem-truncate` and `filesystem-shred` for two rules that deliberately do not opt in.
	 */
	targetScope?: { commandName: string };
}

export interface PermissionGateEvaluation {
	normalizedCommand: string;
	matchedRule: PermissionGateRule | undefined;
	sessionApprovalKey: string | undefined;
	/**
	 * The one directory a session-root grant would cover for this command, when the matched rule is
	 * `targetScope`d and the command names exactly one operand that a grant could describe.
	 * `undefined` means the fifth prompt option must not be offered, because it would grant nothing.
	 */
	grantableTarget: string | undefined;
}

// `\b` treats `-` as a word boundary, so `\brm\b` matches the `--rm` in `docker run --rm`,
// `\bkill\b` matches `--kill-after`, and `\bhalt\b` matches `--halt-on-error`. Every one of
// those is a flag, not the dangerous action. This prefix rejects a preceding `-` as well as a
// preceding word character.
//
// The class rejects `-` and word characters only, never `/` and never `\`: `/bin/rm -rf /` and
// `\rm -rf /` are the same removal by another spelling and have to keep matching.
const COMMAND_WORD_START = String.raw`(?<![-\w])`;

// The one shape COMMAND_WORD_START cannot express: a command whose *name* contains a hyphen.
// `openrc-shutdown` and `k3s-killall.sh` are real commands and real true positives, and a
// lookbehind for `-` alone cannot tell them from a flag. A hyphen that follows a word character
// or a `.` is part of a command name; `--halt-on-error` has `--` before the word, so it stays
// excluded. Use this only where a hyphenated command name actually exists.
const HYPHENATED_COMMAND_WORD_START = String.raw`(?<=[\w.]-)`;
const COMMAND_WORD_OR_HYPHENATED_START = `(?:${COMMAND_WORD_START}|${HYPHENATED_COMMAND_WORD_START})`;

// Redirect policy is intentionally narrow. The previous gate matched nearly any
// absolute-path redirect and produced too many false positives for benign temp files.
// These prefixes are treated as sensitive enough to gate by default.
const SENSITIVE_REDIRECT_PREFIX_PATTERN = String.raw`(?:\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/var\/lib\/|\/System\/|\/Library\/)`;

/**
 * Directories whose contents are throwaway by convention, so removing something *under* one of
 * them is not the act a destructive-removal rule exists to catch. Every recursive-removal prompt in
 * the measured session was a scratchpad teardown under one of these.
 *
 * **Every entry is a literal absolute path, and that is a policy decision, not a simplification.**
 * `$TMPDIR` and `${TMPDIR}` were catalogued in an earlier draft on the reasoning that whatever
 * `TMPDIR` names is a temp directory by definition. It is not: `TMPDIR=/ rm -rf "$TMPDIR/etc"` sets
 * the variable in the same command, so the "root" is chosen by the very string being judged. The
 * expanded macOS value lands under `/var/folders`, which is catalogued, so nothing is lost.
 *
 * **Root matching is case-sensitive, so `rm -rf /TMP/x` prompts.** This is the deliberate *opposite*
 * of `advisor`'s `P6` case-folding fix, and the reason is the direction of failure. There, folding
 * case could only ever widen a denial. Here it would widen an *exemption*: `/TMP/x` and `/tmp/x` are
 * the same directory on macOS and different directories on Linux, so folding case would exempt a
 * genuinely different directory on one of the two platforms. An extra prompt on `/TMP/x` is wrong on
 * neither. Do not "fix" this into a fail-open.
 *
 * A matching operand must also name something *below* the root — `rm -rf /tmp` and `rm -rf /tmp/*`
 * stay gated, because wiping every other process's scratch state is a different act from removing
 * one's own directory under it. That rule is `isWithinRoot`'s `requireSegmentBelow`.
 */
export const EPHEMERAL_TARGET_ROOTS = [
	// `/tmp` is a symlink to `/private/tmp` on macOS, and both spellings appear in real commands.
	"/tmp/",
	"/private/tmp/",
	"/var/tmp/",
	"/private/var/tmp/",
	// The macOS per-user `$TMPDIR`, expanded.
	"/var/folders/",
	"/private/var/folders/",
] as const;

/**
 * `rm --no-preserve-root` exists for exactly one purpose, and a command that reaches for it has
 * announced its intent. It is a free tripwire: no exemption applies to a command containing it,
 * whatever its operands look like.
 */
const NO_PRESERVE_ROOT_PATTERN = /--no-preserve-root\b/i;

/** Session-granted roots are keyed per rule, so one grant never widens into a category bypass (P5). */
const SESSION_ROOT_KEY_INFIX = "::root::";

// SQL-destructive matching is intentionally limited to explicit DB CLI execution
// contexts. This avoids flagging example text such as `echo "DELETE FROM users"`.
// The first-pass allowlist is intentionally small and should only be expanded with
// matching validation coverage.
const DB_CLIENT_PATTERN = "(?:psql|mysql|sqlite3)";
const DB_COMMAND_PREFIX_PATTERN = String.raw`^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:sudo\s+)?${DB_CLIENT_PATTERN}\b[\s\S]*`;

function createDbCommandPattern(sqlPattern: string): RegExp {
	return new RegExp(`${DB_COMMAND_PREFIX_PATTERN}${sqlPattern}`, "i");
}

/**
 * Ordered rule catalogue. Keep the highest-priority / most explanatory rules first
 * because later matches are ignored once an earlier rule matches.
 *
 * Ordering policy:
 * - specific destructive actions should usually appear before broader catch-alls
 * - explanatory, user-facing rules should usually appear before more generic rules
 * - broad privilege markers like `sudo` should stay late so they do not hide the more
 *   useful underlying reason when a command is already dangerous for another reason
 *
 * If you add, remove, or reorder rules, update `test/core.test.ts` in the same pass.
 * Every rule needs at least one positive and one negative case (P4).
 */
export const PERMISSION_GATE_RULES: readonly PermissionGateRule[] = [
	// File system destruction
	{
		id: "filesystem-rm-recursive",
		label: "Recursive file removal",
		category: "filesystem",
		// The class before the `r` excludes `r` on purpose, and matches exactly what `[a-z]*r[a-z]*`
		// matched: a bundled short flag containing at least one `r`. Excluding it pins the match to
		// the *first* `r`, so there is one way to match rather than one per `r` position — the
		// difference between linear and quadratic backtracking on a long non-matching flag, which
		// would hang the gate on the one extension where hanging is a safety failure. Do not
		// "simplify" this back to `[a-z]*`.
		pattern: new RegExp(String.raw`${COMMAND_WORD_START}rm\b\s+(-[a-qs-z]*r[a-z]*|--recursive)\b`, "i"),
		targetScope: { commandName: "rm" },
	},
	{
		id: "filesystem-rm-wildcard",
		label: "Wildcard file removal",
		category: "filesystem",
		pattern: new RegExp(String.raw`${COMMAND_WORD_START}rm\b.*\*`, "i"),
		targetScope: { commandName: "rm" },
	},
	{
		id: "filesystem-rmdir",
		label: "Directory removal",
		category: "filesystem",
		pattern: new RegExp(String.raw`${COMMAND_WORD_START}rmdir\b`, "i"),
		targetScope: { commandName: "rmdir" },
	},
	// `shred -n 3 /tmp/x` is **not** exempted, and cannot be: the tokenizer models no flag arity, so
	// the `3` reads as an operand, looks relative, and nothing is confined. That is measured, not
	// assumed, and it fails safe. What the scope buys here is the plain `shred /tmp/x/secret` form.
	{
		id: "filesystem-shred",
		label: "Secure file deletion",
		category: "filesystem",
		pattern: new RegExp(String.raw`${COMMAND_WORD_START}shred\b`, "i"),
		targetScope: { commandName: "shred" },
	},
	{
		id: "filesystem-sensitive-redirect",
		label: "Shell overwrite of sensitive system path",
		category: "filesystem",
		pattern: new RegExp(String.raw`(?:^|[\s;&|])\d*>>?\s*${SENSITIVE_REDIRECT_PREFIX_PATTERN}`, "i"),
	},
	// Keep this anchored to the invoked command name so SQL phrases like
	// `TRUNCATE TABLE ...` inside DB client commands do not get misclassified as file truncation.
	//
	// Deliberately **no** `targetScope`. `-s SIZE` is a flag with a separate value, and the exemption
	// models no flag arity, so `truncate -s 0 /tmp/f` reads `0` as an operand and can never be
	// exempted while `truncate --size=0 /tmp/f` could. A rule that exempts one spelling and not the
	// other is worse than one that exempts neither, and no false positive here was ever measured (P3).
	{
		id: "filesystem-truncate",
		label: "File truncation",
		category: "filesystem",
		pattern: /^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:sudo\s+)?truncate\b/i,
	},

	// Process management
	{
		id: "process-kill",
		label: "Kill process",
		category: "process",
		pattern: new RegExp(String.raw`${COMMAND_WORD_START}kill\b`, "i"),
	},
	// `process-killall` deliberately keeps a plain `\b`. No `-killall` flag has produced a false
	// positive here, and `k3s-killall.sh` — which really does tear down every workload on the box —
	// is a hyphenated command name that `COMMAND_WORD_START` would stop matching. Narrowing a
	// safety rule needs a measured false positive, not symmetry with its neighbours (P3).
	{ id: "process-killall", label: "Kill all processes", category: "process", pattern: /\bkillall\b/i },
	{
		id: "process-pkill",
		label: "Pattern kill",
		category: "process",
		pattern: new RegExp(String.raw`${COMMAND_WORD_START}pkill\b`, "i"),
	},

	// Package management - uninstall / remove
	{
		id: "package-npm-remove",
		label: "npm uninstall",
		category: "package-manager",
		pattern: /\bnpm\s+(uninstall|remove|r\b)/i,
	},
	{
		id: "package-yarn-remove",
		label: "yarn remove",
		category: "package-manager",
		pattern: /\byarn\s+(remove|unlink)\b/i,
	},
	{
		id: "package-pip-uninstall",
		label: "pip uninstall",
		category: "package-manager",
		pattern: /\bpip\s+uninstall\b/i,
	},
	{
		id: "package-pip3-uninstall",
		label: "pip3 uninstall",
		category: "package-manager",
		pattern: /\bpip3\s+uninstall\b/i,
	},
	{
		id: "package-pnpm-remove",
		label: "pnpm remove",
		category: "package-manager",
		pattern: /\bpnpm\s+(remove|uninstall)\b/i,
	},
	{
		id: "package-poetry-remove",
		label: "poetry remove",
		category: "package-manager",
		pattern: /\bpoetry\s+remove\b/i,
	},
	{
		id: "package-maven-release",
		label: "Maven release",
		category: "package-manager",
		pattern: /\b(?:maven|mvn)\b.*-Prelease\b/i,
	},
	{
		id: "package-brew-remove",
		label: "brew uninstall",
		category: "package-manager",
		pattern: /\bbrew\s+(uninstall|remove)\b/i,
	},
	{
		id: "package-apt-remove",
		label: "apt remove/purge",
		category: "package-manager",
		pattern: /\bapt(?:-get)?\s+(remove|purge|autoremove)\b/i,
	},

	// Docker / containers
	{
		id: "container-docker-destructive",
		label: "Docker destructive operation",
		category: "container",
		pattern: /\bdocker\s+(rm|rmi|volume\s+rm|network\s+rm|system\s+prune|container\s+prune)\b/i,
	},
	{
		id: "container-docker-compose-down-volumes",
		label: "Docker compose down with volumes",
		category: "container",
		pattern: /\bdocker(?:-compose|\s+compose)\s+down\b.*(?:\s-v\b|--volumes\b)/i,
	},
	{
		id: "container-docker-image-prune",
		label: "Docker image prune",
		category: "container",
		pattern: /\bdocker\s+image\s+prune\b/i,
	},
	{
		id: "container-docker-builder-prune",
		label: "Docker builder prune",
		category: "container",
		pattern: /\bdocker\s+builder\s+prune\b/i,
	},

	// Database operations - scoped to explicit DB CLI execution contexts
	{
		id: "database-drop",
		label: "SQL DROP statement",
		category: "database",
		pattern: createDbCommandPattern(String.raw`\bDROP\s+(DATABASE|TABLE|SCHEMA)\b`),
	},
	{
		id: "database-truncate",
		label: "SQL TRUNCATE",
		category: "database",
		pattern: createDbCommandPattern(String.raw`\bTRUNCATE\s+TABLE\b`),
	},
	{
		id: "database-delete",
		label: "SQL DELETE",
		category: "database",
		pattern: createDbCommandPattern(String.raw`\bDELETE\s+FROM\b`),
	},

	// Git destructive
	{
		id: "git-force-push",
		label: "Force git push",
		category: "git",
		pattern: /\bgit\s+push\b.*(?:--force(?:-with-lease)?|-f\b)/i,
	},
	{ id: "git-reset-hard", label: "git reset --hard", category: "git", pattern: /\bgit\s+reset\s+--hard\b/i },
	// The class before the `f` excludes `f` for the reason `filesystem-rm-recursive` states.
	{
		id: "git-clean-force",
		label: "git clean -f",
		category: "git",
		pattern: /\bgit\s+clean\s+(-[a-eg-z]*f[a-z]*)\b/i,
	},

	// Privilege escalation
	// These privilege rules intentionally live after more specific destructive actions.
	// Example: `sudo rm -r dist` should explain the file removal rule, not only `sudo`.
	// `privilege-sudo` deliberately keeps a plain `\b`, unlike its neighbours. `ansible-playbook
	// --sudo` genuinely escalates privilege, so a `-`-prefixed `sudo` is a true positive and
	// COMMAND_WORD_START would disarm it. Do not "make this consistent" (P3).
	{ id: "privilege-sudo", label: "sudo (privilege escalation)", category: "privilege", pattern: /\bsudo\b/i },
	// Two spellings, for the same reason `privilege-sudo` has none: the bare command word must not
	// match the `-su` in `du -su` or `sort -su`, and Ansible's `--su` / `--su-user` become-method is
	// the same true positive as its `--sudo`. `--su` needs both dashes, so `-su` matches neither branch.
	{
		id: "privilege-su",
		label: "su (switch user)",
		category: "privilege",
		pattern: new RegExp(String.raw`(?:${COMMAND_WORD_START}su(?:\s|$)|--su(?:-user)?\b)`, "i"),
	},

	// System
	{
		id: "system-shutdown",
		label: "System shutdown/reboot",
		category: "system",
		pattern: new RegExp(String.raw`${COMMAND_WORD_OR_HYPHENATED_START}(shutdown|reboot|halt|poweroff)\b`, "i"),
	},
	// Policy choice: gate exact octal 777 here, but do not gate sticky-bit 1777 in this pass.
	// If that policy changes later, update both this rule and the validation cases together.
	{
		id: "system-chmod-777",
		label: "chmod 777 (world-writable)",
		category: "system",
		pattern: /\bchmod\b(?:\s+--?[a-z-]+)*\s+777\b/i,
	},

	// Infrastructure / orchestration
	{
		id: "infra-kubectl-delete",
		label: "kubectl delete",
		category: "infrastructure",
		pattern: /\bkubectl\s+delete\b/i,
	},
	{
		id: "infra-terraform-destroy",
		label: "terraform destroy",
		category: "infrastructure",
		pattern: /\bterraform\s+destroy\b/i,
	},
	{
		id: "infra-helm-uninstall",
		label: "helm uninstall",
		category: "infrastructure",
		pattern: /\bhelm\s+uninstall\b/i,
	},
];

// `unknown` is deliberate and is the honest type at this boundary. pi's ToolCallEvent
// union includes CustomToolCallEvent, whose `toolName` is a plain `string` and whose
// `input` is Record<string, unknown> — so an extension-registered tool that happens to
// be named `bash` reaches this code with an arbitrary payload, and `event.input.command`
// is genuinely not known to be a string. The gate must not throw on such a payload, so
// the coercion below is load-bearing rather than defensive noise.
export function normalizeCommand(command: unknown): string {
	const lines = String(command ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);

	let normalized = "";
	for (const line of lines) {
		if (!normalized) {
			normalized = line;
		} else if (LINE_CONTINUES_STATEMENT.test(normalized)) {
			normalized = `${normalized.replace(/\\$/, "").trimEnd()} ${line}`;
		} else {
			normalized = `${normalized.replace(/;+$/, "")}; ${line}`;
		}
	}

	return normalized;
}

/**
 * A newline is a statement separator, and collapsing it to a space is a policy hole rather than a
 * formatting detail: it fuses `rm -rf /tmp/x` with whatever the next line's tokens are, so the next
 * line's arguments read as `rm` operands. The whole exemption below depends on knowing where one
 * statement ends, so the separator has to survive normalization.
 *
 * It is rewritten to `; ` rather than kept as `\n` so that **one** normalizer still feeds matching,
 * keying and display alike (P6). Keeping the raw string for the decision and the collapsed one for
 * the approval key would break "same key ⇒ same decision", which is what makes `P5`'s narrow key
 * mean anything.
 *
 * A line that ends mid-statement is joined with a space instead: a trailing `&&`, `||`, `|` or `&`
 * is already the separator, and a trailing `\` is a continuation of the same statement.
 */
const LINE_CONTINUES_STATEMENT = /(?:\\|&&|\|\||[|&])$/;

function grantedRootsFor(rule: PermissionGateRule, sessionRootGrants: ReadonlySet<string>): string[] {
	const prefix = `${rule.id}${SESSION_ROOT_KEY_INFIX}`;
	return [...sessionRootGrants].filter((grant) => grant.startsWith(prefix)).map((grant) => grant.slice(prefix.length));
}

/**
 * Whether this rule steps aside for this command: it is `targetScope`d, the command does not reach
 * for `--no-preserve-root`, and every invocation of the scoped command is confined either to a
 * catalogued throwaway root or to a root the user granted this session for *this* rule.
 */
function isTargetScopeExempt(
	rule: PermissionGateRule,
	normalizedCommand: string,
	sessionRootGrants: ReadonlySet<string>,
): boolean {
	const { targetScope } = rule;
	if (!targetScope) return false;
	if (NO_PRESERVE_ROOT_PATTERN.test(normalizedCommand)) return false;

	const grantedRoots = grantedRootsFor(rule, sessionRootGrants);

	return hasOnlyExemptTargets(normalizedCommand, targetScope.commandName, (operand) => {
		const canonical = canonicalizeLiteralOperand(operand);
		if (canonical === undefined) return false;

		return (
			EPHEMERAL_TARGET_ROOTS.some((root) => isWithinRoot(canonical, root, true)) ||
			grantedRoots.some((root) => isWithinRoot(canonical, root, false))
		);
	});
}

/**
 * Ordered evaluation helper. This preserves first-match-wins semantics so the first
 * rule in PERMISSION_GATE_RULES always supplies the user-facing explanation.
 *
 * `sessionRootGrants` defaults to empty, and that default is the strict one: with no grants every
 * rule applies exactly as it did before the exemption existed, so a caller that forgets to thread
 * them through gets more prompts rather than fewer.
 */
export function findDangerousRule(
	normalizedCommand: string,
	sessionRootGrants: ReadonlySet<string> = new Set(),
): PermissionGateRule | undefined {
	if (!normalizedCommand) {
		return undefined;
	}

	return PERMISSION_GATE_RULES.find(
		(rule) =>
			rule.pattern.test(normalizedCommand) && !isTargetScopeExempt(rule, normalizedCommand, sessionRootGrants),
	);
}

export function createSessionApprovalKey(rule: PermissionGateRule, normalizedCommand: string): string {
	// Approval keys intentionally bind both the matched rule and the normalized command.
	// This keeps session approvals narrow and prevents a broad category-level bypass.
	return `${rule.id}::${normalizedCommand}`;
}

export function createSessionRootKey(rule: PermissionGateRule, root: string): string {
	return `${rule.id}${SESSION_ROOT_KEY_INFIX}${root}`;
}

/**
 * The single directory a session-root grant would cover, or `undefined` when there is no such thing
 * and the option must not be offered.
 *
 * The shape conditions are about the grant being a sensible thing to remember: it has to be *one*
 * operand, because a grant covering half a two-operand command is not a grant; absolute, because a
 * relative path grants against a `cwd` this module cannot see; two segments or more, so a stray
 * `rm -rf /Users` cannot offer to exempt a whole home directory tree; and a literal, which
 * `canonicalizeLiteralOperand` already guarantees.
 *
 * The last condition is the one a list of shape rules cannot express, so it is **asked rather than
 * predicted**: re-run the whole catalogue with the grant applied, and offer the option only if the
 * command would then pass. `sudo rm -rf /Users/me/x` is the case that needs it — the grant is a
 * perfectly well-formed one and it does step the removal rule aside, but `privilege-sudo` matches
 * next and the user is prompted again, so an option promising to silence the command would have
 * lied. An option that grants nothing the user can see is worse than an absent one.
 *
 * **The operand itself is granted, never its parent.** Granting the parent would cover a whole
 * scratch area with one prompt, which is the more useful shape and is rejected for it:
 * `rm -rf ~/project/dist` would grant `~/project`, silently exempting `rm -rf ~/project/src` for the
 * rest of the session.
 */
export function findGrantableTarget(
	rule: PermissionGateRule,
	normalizedCommand: string,
	sessionRootGrants: ReadonlySet<string> = new Set(),
): string | undefined {
	const { targetScope } = rule;
	if (!targetScope) return undefined;

	const operands = new Set(
		splitCommandStatements(normalizedCommand).flatMap((statement) =>
			findInvocationOperands(statement, targetScope.commandName).flat(),
		),
	);
	if (operands.size !== 1) return undefined;

	const canonical = canonicalizeLiteralOperand([...operands][0]!);
	if (canonical === undefined || canonical.includes("*")) return undefined;

	const root = canonical.replace(/\/+$/, "");
	if (!root.startsWith("/") || root.split("/").filter(Boolean).length < 2) return undefined;

	const withGrant = new Set([...sessionRootGrants, createSessionRootKey(rule, root)]);
	return findDangerousRule(normalizedCommand, withGrant) === undefined ? root : undefined;
}

export function evaluateDangerousCommand(
	command: unknown,
	sessionRootGrants: ReadonlySet<string> = new Set(),
): PermissionGateEvaluation {
	const normalizedCommand = normalizeCommand(command);
	const matchedRule = findDangerousRule(normalizedCommand, sessionRootGrants);

	return {
		normalizedCommand,
		matchedRule,
		sessionApprovalKey: matchedRule ? createSessionApprovalKey(matchedRule, normalizedCommand) : undefined,
		grantableTarget: matchedRule ? findGrantableTarget(matchedRule, normalizedCommand, sessionRootGrants) : undefined,
	};
}

/**
 * Truncation keeps the head **and** the tail, because after the ephemeral-target exemption the
 * normal shape of a gated removal is a long benign prefix with the dangerous part at the end —
 * `rm -rf /tmp/<long scratch path> && rm -rf ~`. A head-only preview would show the user the half
 * of the command they were never going to object to.
 */
export function formatCommandPreview(command: string, maxLength: number = COMMAND_PREVIEW_MAX_LENGTH): string {
	const normalizedCommand = normalizeCommand(command);
	if (normalizedCommand.length <= maxLength) {
		return normalizedCommand;
	}

	const ellipsis = "...";
	const kept = Math.max(0, maxLength - ellipsis.length);
	const head = Math.ceil(kept / 2);
	const tail = kept - head;

	return `${normalizedCommand.slice(0, head)}${ellipsis}${tail > 0 ? normalizedCommand.slice(-tail) : ""}`;
}

export function formatRuleSummary(rule: PermissionGateRule): string {
	return `[${rule.id}] ${rule.label}`;
}
