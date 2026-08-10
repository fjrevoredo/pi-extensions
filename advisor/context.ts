import { buildSessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SYSTEM_PROMPT } from "./contracts.ts";
import { composeEvidence } from "./evidence.ts";

/**
 * The pi-facing shell around evidence assembly: get the session out of pi, get
 * the git snapshot from the caller, and hand both to the pure composer.
 *
 * It holds no decisions of its own. Everything about what the advisor is shown —
 * which messages count, in what order, how much survives, what is redacted —
 * lives in evidence.ts so it can be tested with no pi runtime (S1).
 */
export async function buildAdvisorContext(
	ctx: ExtensionContext,
	maxBytes: number,
	gitSnapshot: () => Promise<string>,
	redact = true,
): Promise<{ systemPrompt: string; evidence: string }> {
	const session = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const snapshot = await gitSnapshot();
	return {
		systemPrompt: SYSTEM_PROMPT,
		evidence: composeEvidence({
			messages: session.messages,
			driverInstructions: ctx.getSystemPrompt(),
			snapshot,
			maxBytes,
			redact,
		}),
	};
}
