/**
 * Permission Gate Extension
 *
 * Global Pi extension entrypoint for guarding dangerous `bash` tool calls.
 *
 * File layout:
 * - `permission-gate.ts` handles Pi lifecycle hooks and the interactive approval flow.
 * - `permission-gate/core.mjs` owns the rule catalogue, matching helpers, normalization,
 *   and formatting helpers shared by runtime and validation.
 * - `permission-gate/validate.mjs` is a global smoke/regression helper and is not an
 *   extension entrypoint.
 *
 * Scope boundary:
 * - This extension intentionally guards `bash` only.
 * - It is a guardrail, not a security boundary or shell parser.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  evaluateDangerousCommand,
  formatCommandPreview,
  formatRuleSummary,
} from "./permission-gate/core.mjs";

const ALLOW_ONCE_OPTION = "Allow once";
const ALLOW_FOR_SESSION_OPTION = "Allow for this session";
const EXPLAIN_COMMAND_OPTION = "Explain this command";
const BLOCK_OPTION = "Block";

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

  pi.on("session_shutdown", async () => {
    sessionApprovals.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") {
      return undefined;
    }

    const evaluation = evaluateDangerousCommand(event.input.command);
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
    // - Explain this command: deny execution, ask the agent to explain and retry
    // - Block: deny execution and return a searchable reason containing the matched rule id
    const choice = await ctx.ui.select(
      `${rulePromptTitle}\n\n${rulePromptMeta}\n\n$ ${formatCommandPreview(evaluation.normalizedCommand)}\n\nChoose an action:`,
      [ALLOW_ONCE_OPTION, ALLOW_FOR_SESSION_OPTION, EXPLAIN_COMMAND_OPTION, BLOCK_OPTION],
    );

    if (choice === ALLOW_ONCE_OPTION) {
      return undefined;
    }

    if (choice === ALLOW_FOR_SESSION_OPTION) {
      sessionApprovals.add(evaluation.sessionApprovalKey);
      return undefined;
    }

    // This path is intentionally stateless from the extension's point of view.
    // We deny execution and inject a steering user message that asks the agent to
    // explain the command and then retry the same command once for fresh approval.
    if (choice === EXPLAIN_COMMAND_OPTION) {
      pi.sendUserMessage(buildExplainCommandMessage(ruleSummary, evaluation.normalizedCommand), { deliverAs: "steer" });
      return { block: true, reason: `Explanation requested by user: ${ruleSummary}` };
    }

    return { block: true, reason: `Blocked by user: ${ruleSummary}` };
  });
}
