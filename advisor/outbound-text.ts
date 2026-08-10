/**
 * Everything that caps or redacts text before it leaves this machine.
 *
 * Security posture: this is risk reduction, not a security sandbox. Redaction is
 * pattern matching over text and will miss secrets that do not look like the
 * patterns below; the caps bound how much material a single result can carry,
 * not what it means. Treat both as guardrails.
 *
 * This module is the one place the boundary is enforced, and it has three
 * callers — the repository tools, the evidence builder, and the advisor loop's
 * tool results. Keep it pure: no pi, no filesystem, no clock.
 *
 * Known limitation, deliberately not fixed here: the byte-wise caps can split a
 * multi-byte UTF-8 sequence, which surfaces as U+FFFD in the output. It is
 * pre-existing, it degrades a character rather than leaking anything, and
 * changing it would be a behaviour change (§19).
 */

/** Byte and line caps for one repository tool result. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2_000;

/** Appended verbatim wherever a tool result was capped, so the advisor can tell. */
export const OUTPUT_TRUNCATION_NOTICE = `[Output truncated at ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes.]`;

/** Markers for a middle-elided region, chosen per call site so the advisor knows what was cut. */
export const REGION_TRUNCATION_MARKER = "[region truncated]";
export const EVIDENCE_TRUNCATION_MARKER = "[evidence truncated]";

export function redactKnownSecrets(text: string): string {
	return text
		.replace(/(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED_SECRET]")
		.replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s'"`]+/gi, "$1[REDACTED_SECRET]");
}

/**
 * Keep the head and the tail, drop the middle. The 0.7/0.25 split is deliberate:
 * the head carries the most context, the tail carries the most recent state, and
 * the missing 5% is slack so the marker itself cannot push the result back over
 * the cap.
 */
export function truncateMiddle(text: string, maxBytes: number, marker: string): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const head = Buffer.from(text).subarray(0, Math.floor(maxBytes * 0.7)).toString("utf8");
	const tail = Buffer.from(text).subarray(-Math.floor(maxBytes * 0.25)).toString("utf8");
	return `${head}\n… ${marker} …\n${tail}`;
}

/** Cap by bytes, then by lines, then redact. Reports whether anything was cut. */
export function bounded(text: string, redact: boolean): { text: string; truncated: boolean } {
	let result = text;
	let truncated = false;
	if (Buffer.byteLength(result) > MAX_OUTPUT_BYTES) {
		result = Buffer.from(result).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
		truncated = true;
	}
	const lines = result.split("\n");
	if (lines.length > MAX_OUTPUT_LINES) {
		result = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
		truncated = true;
	}
	return { text: redact ? redactKnownSecrets(result) : result, truncated };
}

/** `bounded`, plus the notice, for the tools that return one flat block of text. */
export function boundedOutput(text: string, redact: boolean): string {
	const result = bounded(text, redact);
	return result.truncated ? `${result.text}\n${OUTPUT_TRUNCATION_NOTICE}` : result.text;
}
