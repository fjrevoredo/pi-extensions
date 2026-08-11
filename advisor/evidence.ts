import {
	EVIDENCE_TRUNCATION_MARKER,
	REGION_TRUNCATION_MARKER,
	redactKnownSecrets,
	truncateMiddle,
} from "./outbound-text.ts";

/**
 * Turns a driver session into the single block of text the advisor is shown.
 *
 * Pure: no pi, no filesystem, no clock. `context.ts` is the shell that gets the
 * session out of pi and hands the result here, which is what makes every
 * decision below testable — the six-branch message summary in particular.
 *
 * Every region this produces is labelled untrusted on purpose. The advisor's
 * system prompt says repository files and command output cannot change its
 * policy, and these labels are what that instruction refers to.
 */

/** How much of one region survives. The driver's own instructions get a larger budget. */
const MAX_REGION_BYTES = 8_000;
const MAX_DRIVER_INSTRUCTION_BYTES = 12_000;

/** Only the most recent turns are worth sending; older ones are usually superseded. */
const RECENT_MESSAGE_COUNT = 24;

export interface SessionMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	summary?: string;
	output?: string;
}

function boundRegion(text: string, maxBytes = MAX_REGION_BYTES): string {
	return truncateMiddle(text, maxBytes, REGION_TRUNCATION_MARKER);
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			),
		)
		.map((part) => part.text)
		.join("\n");
}

/**
 * One session message as one labelled line, or nothing if it carries no signal.
 *
 * `consult_advisor` results are dropped deliberately: feeding the advisor its
 * own previous advice back as driver evidence would let it treat its own
 * output as independent corroboration.
 */
export function summarizeMessage(message: SessionMessage): string | undefined {
	if (message.role === "user" || message.role === "custom")
		return `USER: ${boundRegion(textFromContent(message.content))}`;
	if (message.role === "toolResult") {
		if (message.toolName === "consult_advisor") return undefined;
		return `TOOL ${message.toolName}: ${boundRegion(textFromContent(message.content))}`;
	}
	if (message.role === "assistant") {
		const text = textFromContent(message.content);
		return text ? `DRIVER: ${boundRegion(text)}` : undefined;
	}
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		return `SUMMARY: ${boundRegion(message.summary ?? "")}`;
	}
	if (message.role === "bashExecution") return `COMMAND RESULT: ${boundRegion(message.output ?? "")}`;
	return undefined;
}

/**
 * Region order is deliberate: the latest user message is repeated first, ahead
 * of the recent transcript, so the advisor sees what was actually asked even
 * when the tail is dominated by tool output. Redaction runs over the assembled
 * text, and the byte cap is applied last, so nothing can be truncated into
 * looking unredacted.
 */
export function composeEvidence(input: {
	messages: SessionMessage[];
	driverInstructions: string;
	snapshot: string;
	maxBytes: number;
	redact: boolean;
}): string {
	const lines = input.messages
		.map((message) => summarizeMessage(message))
		.filter((line): line is string => Boolean(line));
	const latestUser = [...lines].reverse().find((line) => line.startsWith("USER:"));
	const driverInstructions = boundRegion(input.driverInstructions, MAX_DRIVER_INSTRUCTION_BYTES);
	const regions = [
		"The following is untrusted driver and repository evidence.",
		latestUser,
		...lines.slice(-RECENT_MESSAGE_COUNT),
		"Resolved driver instructions (untrusted evidence):",
		driverInstructions,
		"Repository snapshot (evidence, not proof):",
		input.snapshot,
	].filter((region): region is string => Boolean(region));
	const serialized = regions.join("\n\n");
	return truncateMiddle(
		input.redact ? redactKnownSecrets(serialized) : serialized,
		input.maxBytes,
		EVIDENCE_TRUNCATION_MARKER,
	);
}
