/**
 * Permission Gate Extension
 *
 * Global Pi extension entrypoint for guarding dangerous `bash` tool calls.
 *
 * File layout:
 * - `index.ts` handles Pi lifecycle hooks and the interactive approval flow.
 * - `core.ts` owns the rule catalogue, matching helpers, normalization, and the
 *   formatting helpers shared with the tests.
 *
 * Scope boundary:
 * - This extension intentionally guards `bash` only.
 * - It is a guardrail, not a security boundary or shell parser.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionRootKey, evaluateDangerousCommand, formatCommandPreview, formatRuleSummary } from "./core.ts";

const ALLOW_ONCE_OPTION = "Allow once";
const ALLOW_FOR_SESSION_OPTION = "Allow for this session";
const EXPLAIN_COMMAND_OPTION = "Explain this command";
const BLOCK_OPTION = "Block";

// The fifth option's label carries the directory it would grant, because that directory is the whole
// content of the decision. It is built rather than constant for that reason.
function formatAllowForTargetOption(target: string) {
	return `Allow this rule under ${target} for this session`;
}

// Prompt-title helpers intentionally stay local to the entrypoint because they are
// pure presentation concerns for the interactive TUI prompt, not policy concerns.
function formatRulePromptTitle(ruleSummary: string) {
	const prettyLabel = ruleSummary.replace(/^\[[^\]]+\]\s*/, "");
	return `⚠️  ${prettyLabel}`;
}

function formatRulePromptMeta(ruleSummary: string) {
	const ruleIdMatch = ruleSummary.match(/^\[([^\]]+)\]/);
	return ruleIdMatch ? `  rule: ${ruleIdMatch[1]}` : "";
}

// The explain flow is intentionally stateless from the extension's point of view:
// we block the command, inject a steering user message, and rely on the agent to
// explain first and then retry the exact same command once for a fresh approval prompt.
function buildExplainCommandMessage(ruleSummary: string, normalizedCommand: string) {
	return [
		"The previous bash command was blocked because the user selected 'Explain this command' instead of approving execution.",
		"",
		`Matched permission-gate rule: ${ruleSummary}`,
		"",
		"Blocked command:",
		"```bash",
		normalizedCommand,
		"```",
		"",
		"Your required behaviour is:",
		"1. First, send a normal assistant message explaining the blocked command to the user.",
		"2. In that explanation, cover all of the following:",
		"   - why you want to run this command",
		"   - why you chose this exact command or command combination",
		"   - what result you expect",
		"3. Do not run any tool before giving that explanation.",
		"4. Do not claim the command already ran. It was blocked.",
		"5. After giving the explanation, if you still want to perform it, invoke the exact same bash command once, unchanged, so the user can approve or deny it.",
		"6. Do not replace the command with a different command, a simplified variant, or a paraphrase.",
	].join("\n");
}

export default function permissionGate(pi: ExtensionAPI) {
	// Session-scoped approvals are kept in memory only. Pi tears down and reloads the
	// extension runtime on session replacement flows, and we also clear the cache on
	// session_shutdown so approvals never outlive the current session runtime.
	//
	// Approval keys are intentionally narrow:
	// - matched rule id
	// - normalized command string
	//
	// This means:
	// - whitespace-only command differences collapse to the same approval
	// - a different command under the same rule still prompts again
	// - a different rule for the same-looking command still prompts again
	const sessionApprovals = new Set<string>();

	// Session-granted roots, kept separately from `sessionApprovals` because they answer a different
	// question: not "was this exact command approved" but "is this rule exempt under this directory".
	// A grant is keyed to the matched rule and to one directory, so it never widens into a
	// category-level bypass (P5), and it is cleared on shutdown alongside the approvals.
	const sessionRootGrants = new Set<string>();

	pi.on("session_shutdown", async () => {
		sessionApprovals.clear();
		sessionRootGrants.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			return undefined;
		}

		const evaluation = evaluateDangerousCommand(event.input.command, sessionRootGrants);
		if (!evaluation.matchedRule || !evaluation.sessionApprovalKey) {
			return undefined;
		}

		const ruleSummary = formatRuleSummary(evaluation.matchedRule);
		const rulePromptTitle = formatRulePromptTitle(ruleSummary);
		const rulePromptMeta = formatRulePromptMeta(ruleSummary);

		if (sessionApprovals.has(evaluation.sessionApprovalKey)) {
			return undefined;
		}

		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (no UI for confirmation): ${ruleSummary}` };
		}

		// Interactive behaviour is intentionally explicit:
		// - Allow once: let only this tool call through
		// - Allow for this session: cache approval for the same normalized command + rule id
		// - Allow this rule under <dir>: exempt this rule for that directory and anything below it
		// - Explain this command: deny execution, ask the agent to explain and retry
		// - Block: deny execution and return a searchable reason containing the matched rule id
		//
		// The fourth is offered only when `core.ts` found a directory a grant would actually cover.
		// The other four are shown unchanged otherwise, because an option that grants nothing is
		// worse than an absent one.
		const allowForTargetOption = evaluation.grantableTarget
			? formatAllowForTargetOption(evaluation.grantableTarget)
			: undefined;

		const choice = await ctx.ui.select(
			`${rulePromptTitle}\n\n${rulePromptMeta}\n\n$ ${formatCommandPreview(evaluation.normalizedCommand)}\n\nChoose an action:`,
			[
				ALLOW_ONCE_OPTION,
				ALLOW_FOR_SESSION_OPTION,
				...(allowForTargetOption ? [allowForTargetOption] : []),
				EXPLAIN_COMMAND_OPTION,
				BLOCK_OPTION,
			],
		);

		if (choice === ALLOW_ONCE_OPTION) {
			return undefined;
		}

		if (choice === ALLOW_FOR_SESSION_OPTION) {
			sessionApprovals.add(evaluation.sessionApprovalKey);
			return undefined;
		}

		if (allowForTargetOption && choice === allowForTargetOption && evaluation.grantableTarget) {
			sessionRootGrants.add(createSessionRootKey(evaluation.matchedRule, evaluation.grantableTarget));
			return undefined;
		}

		// This path is intentionally stateless from the extension's point of view.
		// We deny execution and inject a steering user message that asks the agent to
		// explain the command and then retry the same command once for fresh approval.
		if (choice === EXPLAIN_COMMAND_OPTION) {
			pi.sendUserMessage(buildExplainCommandMessage(ruleSummary, evaluation.normalizedCommand), {
				deliverAs: "steer",
			});
			return { block: true, reason: `Explanation requested by user: ${ruleSummary}` };
		}

		return { block: true, reason: `Blocked by user: ${ruleSummary}` };
	});
}
