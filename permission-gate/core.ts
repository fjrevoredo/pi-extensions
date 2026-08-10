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
 * TUI and no pi runtime. It imports nothing.
 *
 * Rule order is significant: evaluation is first-match-wins, so earlier rules take
 * precedence over later ones when a command matches multiple patterns.
 */

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
}

export interface PermissionGateEvaluation {
	normalizedCommand: string;
	matchedRule: PermissionGateRule | undefined;
	sessionApprovalKey: string | undefined;
}

// Redirect policy is intentionally narrow. The previous gate matched nearly any
// absolute-path redirect and produced too many false positives for benign temp files.
// These prefixes are treated as sensitive enough to gate by default.
const SENSITIVE_REDIRECT_PREFIX_PATTERN = String.raw`(?:\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/var\/lib\/|\/System\/|\/Library\/)`;

// SQL-destructive matching is intentionally limited to explicit DB CLI execution
// contexts. This avoids flagging example text such as `echo "DELETE FROM users"`.
// The first-pass allowlist is intentionally small and should only be expanded with
// matching validation coverage.
const DB_CLIENT_PATTERN = String.raw`(?:psql|mysql|sqlite3)`;
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
		pattern: /\brm\b\s+(-[a-z]*r[a-z]*|--recursive)\b/i,
	},
	{ id: "filesystem-rm-wildcard", label: "Wildcard file removal", category: "filesystem", pattern: /\brm\b.*\*/i },
	{ id: "filesystem-rmdir", label: "Directory removal", category: "filesystem", pattern: /\brmdir\b/i },
	{ id: "filesystem-shred", label: "Secure file deletion", category: "filesystem", pattern: /\bshred\b/i },
	{
		id: "filesystem-sensitive-redirect",
		label: "Shell overwrite of sensitive system path",
		category: "filesystem",
		pattern: new RegExp(String.raw`(?:^|[\s;&|])\d*>>?\s*${SENSITIVE_REDIRECT_PREFIX_PATTERN}`, "i"),
	},
	// Keep this anchored to the invoked command name so SQL phrases like
	// `TRUNCATE TABLE ...` inside DB client commands do not get misclassified as file truncation.
	{
		id: "filesystem-truncate",
		label: "File truncation",
		category: "filesystem",
		pattern: /^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:sudo\s+)?truncate\b/i,
	},

	// Process management
	{ id: "process-kill", label: "Kill process", category: "process", pattern: /\bkill\b/i },
	{ id: "process-killall", label: "Kill all processes", category: "process", pattern: /\bkillall\b/i },
	{ id: "process-pkill", label: "Pattern kill", category: "process", pattern: /\bpkill\b/i },

	// Package management - uninstall / remove
	{ id: "package-npm-remove", label: "npm uninstall", category: "package-manager", pattern: /\bnpm\s+(uninstall|remove|r\b)/i },
	{ id: "package-yarn-remove", label: "yarn remove", category: "package-manager", pattern: /\byarn\s+(remove|unlink)\b/i },
	{ id: "package-pip-uninstall", label: "pip uninstall", category: "package-manager", pattern: /\bpip\s+uninstall\b/i },
	{ id: "package-pip3-uninstall", label: "pip3 uninstall", category: "package-manager", pattern: /\bpip3\s+uninstall\b/i },
	{ id: "package-pnpm-remove", label: "pnpm remove", category: "package-manager", pattern: /\bpnpm\s+(remove|uninstall)\b/i },
	{ id: "package-poetry-remove", label: "poetry remove", category: "package-manager", pattern: /\bpoetry\s+remove\b/i },
	{ id: "package-maven-release", label: "Maven release", category: "package-manager", pattern: /\b(?:maven|mvn)\b.*-Prelease\b/i },
	{ id: "package-brew-remove", label: "brew uninstall", category: "package-manager", pattern: /\bbrew\s+(uninstall|remove)\b/i },
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
	{ id: "container-docker-image-prune", label: "Docker image prune", category: "container", pattern: /\bdocker\s+image\s+prune\b/i },
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
	{ id: "database-delete", label: "SQL DELETE", category: "database", pattern: createDbCommandPattern(String.raw`\bDELETE\s+FROM\b`) },

	// Git destructive
	{ id: "git-force-push", label: "Force git push", category: "git", pattern: /\bgit\s+push\b.*(?:--force(?:-with-lease)?|-f\b)/i },
	{ id: "git-reset-hard", label: "git reset --hard", category: "git", pattern: /\bgit\s+reset\s+--hard\b/i },
	{ id: "git-clean-force", label: "git clean -f", category: "git", pattern: /\bgit\s+clean\s+(-[a-z]*f[a-z]*)\b/i },

	// Privilege escalation
	// These privilege rules intentionally live after more specific destructive actions.
	// Example: `sudo rm -r dist` should explain the file removal rule, not only `sudo`.
	{ id: "privilege-sudo", label: "sudo (privilege escalation)", category: "privilege", pattern: /\bsudo\b/i },
	{ id: "privilege-su", label: "su (switch user)", category: "privilege", pattern: /\bsu(?:\s|$)/i },

	// System
	{ id: "system-shutdown", label: "System shutdown/reboot", category: "system", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
	// Policy choice: gate exact octal 777 here, but do not gate sticky-bit 1777 in this pass.
	// If that policy changes later, update both this rule and the validation cases together.
	{ id: "system-chmod-777", label: "chmod 777 (world-writable)", category: "system", pattern: /\bchmod\b(?:\s+--?[a-z-]+)*\s+777\b/i },

	// Infrastructure / orchestration
	{ id: "infra-kubectl-delete", label: "kubectl delete", category: "infrastructure", pattern: /\bkubectl\s+delete\b/i },
	{ id: "infra-terraform-destroy", label: "terraform destroy", category: "infrastructure", pattern: /\bterraform\s+destroy\b/i },
	{ id: "infra-helm-uninstall", label: "helm uninstall", category: "infrastructure", pattern: /\bhelm\s+uninstall\b/i },
];

// `unknown` is deliberate and is the honest type at this boundary. pi's ToolCallEvent
// union includes CustomToolCallEvent, whose `toolName` is a plain `string` and whose
// `input` is Record<string, unknown> — so an extension-registered tool that happens to
// be named `bash` reaches this code with an arbitrary payload, and `event.input.command`
// is genuinely not known to be a string. The gate must not throw on such a payload, so
// the coercion below is load-bearing rather than defensive noise.
export function normalizeCommand(command: unknown): string {
	return String(command ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Ordered evaluation helper. This preserves first-match-wins semantics so the first
 * rule in PERMISSION_GATE_RULES always supplies the user-facing explanation.
 */
export function findDangerousRule(normalizedCommand: string): PermissionGateRule | undefined {
	if (!normalizedCommand) {
		return undefined;
	}

	return PERMISSION_GATE_RULES.find(({ pattern }) => pattern.test(normalizedCommand));
}

export function createSessionApprovalKey(rule: PermissionGateRule, normalizedCommand: string): string {
	// Approval keys intentionally bind both the matched rule and the normalized command.
	// This keeps session approvals narrow and prevents a broad category-level bypass.
	return `${rule.id}::${normalizedCommand}`;
}

export function evaluateDangerousCommand(command: unknown): PermissionGateEvaluation {
	const normalizedCommand = normalizeCommand(command);
	const matchedRule = findDangerousRule(normalizedCommand);

	return {
		normalizedCommand,
		matchedRule,
		sessionApprovalKey: matchedRule ? createSessionApprovalKey(matchedRule, normalizedCommand) : undefined,
	};
}

export function formatCommandPreview(command: string, maxLength: number = COMMAND_PREVIEW_MAX_LENGTH): string {
	const normalizedCommand = normalizeCommand(command);
	if (normalizedCommand.length <= maxLength) {
		return normalizedCommand;
	}

	return `${normalizedCommand.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatRuleSummary(rule: PermissionGateRule): string {
	return `[${rule.id}] ${rule.label}`;
}
