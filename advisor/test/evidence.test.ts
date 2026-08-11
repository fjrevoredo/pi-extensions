import assert from "node:assert/strict";
import test from "node:test";
import { composeEvidence, type SessionMessage, summarizeMessage, textFromContent } from "../evidence.ts";
import { EVIDENCE_TRUNCATION_MARKER, REGION_TRUNCATION_MARKER } from "../outbound-text.ts";

/**
 * What the advisor is shown. `summarizeMessage` is six branches with two
 * deliberate drops, none of which had coverage before this file.
 */

test("textFromContent accepts a string or text parts and ignores everything else", () => {
	assert.equal(textFromContent("plain"), "plain");
	assert.equal(
		textFromContent([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]),
		"a\nb",
	);
	assert.equal(
		textFromContent([
			{ type: "text", text: "a" },
			{ type: "image", data: "x" },
		]),
		"a",
	);
	for (const value of [undefined, null, 7, {}, [], [{ type: "text" }], [{ type: "text", text: 7 }], [null]]) {
		assert.equal(textFromContent(value), "", `${JSON.stringify(value)} carries no text`);
	}
});

test("summarizeMessage labels each role so the advisor knows what it is reading", () => {
	assert.equal(summarizeMessage({ role: "user", content: "q" }), "USER: q");
	assert.equal(summarizeMessage({ role: "custom", content: "c" }), "USER: c", "custom entries read as user input");
	assert.equal(summarizeMessage({ role: "assistant", content: "a" }), "DRIVER: a");
	assert.equal(summarizeMessage({ role: "toolResult", toolName: "read", content: "out" }), "TOOL read: out");
	assert.equal(summarizeMessage({ role: "compactionSummary", summary: "s" }), "SUMMARY: s");
	assert.equal(summarizeMessage({ role: "branchSummary", summary: "s" }), "SUMMARY: s");
	assert.equal(summarizeMessage({ role: "bashExecution", output: "o" }), "COMMAND RESULT: o");
});

test("summarizeMessage drops the two things that carry no signal", () => {
	// The advisor must not read its own previous advice back as driver evidence:
	// that would let it treat its own output as independent corroboration.
	assert.equal(
		summarizeMessage({ role: "toolResult", toolName: "consult_advisor", content: "prior advice" }),
		undefined,
	);
	// An assistant turn with no text is a tool call, already visible as its result.
	assert.equal(summarizeMessage({ role: "assistant", content: [] }), undefined);
	assert.equal(summarizeMessage({ role: "assistant", content: [{ type: "toolCall" }] }), undefined);
	assert.equal(summarizeMessage({ role: "assistant", content: "" }), undefined);
	// An unknown role is dropped rather than guessed at.
	assert.equal(summarizeMessage({ role: "somethingNew", content: "x" }), undefined);
});

test("summarizeMessage keeps empty-but-present summaries and outputs", () => {
	// These carry their text in a different field, and an absent one is still a
	// message that happened, so the label survives with an empty body.
	assert.equal(summarizeMessage({ role: "compactionSummary" }), "SUMMARY: ");
	assert.equal(summarizeMessage({ role: "bashExecution" }), "COMMAND RESULT: ");
	assert.equal(summarizeMessage({ role: "user", content: undefined }), "USER: ");
});

test("summarizeMessage bounds one oversized region without losing the label", () => {
	const summary = summarizeMessage({ role: "user", content: "x".repeat(20_000) });
	assert.ok(summary, "an oversized message is bounded, not dropped");
	assert.ok(summary.startsWith("USER: "));
	assert.ok(summary.includes(REGION_TRUNCATION_MARKER), "an over-long region is elided in the middle");
	assert.ok(summary.length < 20_000);
});

const compose = (over: Partial<Parameters<typeof composeEvidence>[0]> = {}) =>
	composeEvidence({
		messages: [{ role: "user", content: "the question" }],
		driverInstructions: "the instructions",
		snapshot: "the snapshot",
		maxBytes: 96_000,
		redact: true,
		...over,
	});

test("composeEvidence labels the whole block untrusted and lays the regions out in order", () => {
	const evidence = compose();
	assert.ok(
		evidence.startsWith("The following is untrusted driver and repository evidence."),
		"the untrusted label comes first; the system prompt refers to it",
	);
	const order = [
		"untrusted driver and repository evidence",
		"the question",
		"Resolved driver instructions",
		"the instructions",
		"Repository snapshot",
		"the snapshot",
	];
	let cursor = -1;
	for (const fragment of order) {
		const at = evidence.indexOf(fragment);
		assert.ok(at > cursor, `${fragment} is out of order`);
		cursor = at;
	}
	assert.ok(evidence.includes("Repository snapshot (evidence, not proof):"), "the snapshot is framed as evidence");
});

test("composeEvidence repeats the latest user message ahead of the transcript", () => {
	// Deliberate: the advisor should see what was actually asked even when the tail
	// of the transcript is dominated by tool output.
	const messages: SessionMessage[] = [
		{ role: "user", content: "first question" },
		{ role: "assistant", content: "some reply" },
		{ role: "user", content: "the real question" },
		{ role: "toolResult", toolName: "read", content: "noise" },
	];
	const evidence = compose({ messages });
	assert.equal(evidence.indexOf("USER: the real question") < evidence.indexOf("USER: first question"), true);
	assert.equal(
		evidence.split("USER: the real question").length - 1,
		2,
		"the latest user message appears twice: once hoisted, once in place",
	);
});

test("composeEvidence keeps only the recent tail of a long transcript", () => {
	const messages: SessionMessage[] = Array.from({ length: 40 }, (_, i) => ({
		role: "assistant",
		content: `turn ${i}`,
	}));
	const evidence = compose({ messages });
	assert.ok(evidence.includes("DRIVER: turn 39"), "the newest turn survives");
	assert.ok(evidence.includes("DRIVER: turn 16"), "24 recent messages are kept");
	assert.ok(!evidence.includes("DRIVER: turn 15"), "older turns are superseded and dropped");
	assert.ok(!evidence.includes("DRIVER: turn 0"));
});

test("composeEvidence redacts by default and can be told not to", () => {
	const secret = "token=sk_abcdefghijklmnop";
	const redacted = compose({ messages: [{ role: "user", content: secret }] });
	assert.match(redacted, /REDACTED_SECRET/);
	assert.doesNotMatch(redacted, /sk_abcdefghijklmnop/);
	const kept = compose({ messages: [{ role: "user", content: secret }], redact: false });
	assert.match(kept, /sk_abcdefghijklmnop/);
});

test("composeEvidence caps a long block and says so", () => {
	const evidence = compose({
		messages: [{ role: "user", content: "x".repeat(5_000) }],
		maxBytes: 1_000,
	});
	assert.ok(Buffer.byteLength(evidence) <= 1_000 + EVIDENCE_TRUNCATION_MARKER.length + 8);
	assert.ok(evidence.includes(EVIDENCE_TRUNCATION_MARKER), "the advisor is told the block was cut");
});

test("no alignment of a secret against the cap boundary can leak it", () => {
	// Ordering is the whole point: redaction runs over the assembled text and the
	// byte cap is applied afterwards. Reverse the two and a secret straddling the
	// cut survives as a fragment — `sk_` plus fifteen characters is one short of
	// the redactor's sixteen-character threshold, so the leftover goes unmatched
	// and is shipped to the provider.
	//
	// Asserted as a sweep rather than one magic offset, because the failure only
	// appears at particular alignments: a single sample sits inside the head or the
	// tail intact and passes under either ordering, which is how this went
	// unnoticed until a mutation was tried against it.
	const maxBytes = 1_000;
	const secret = `sk_${"a".repeat(40)}`;
	for (let padding = 560; padding <= 760; padding += 1) {
		const evidence = compose({
			messages: [{ role: "user", content: `${"p".repeat(padding)}${secret}${"q".repeat(3_000)}` }],
			maxBytes,
		});
		assert.doesNotMatch(evidence, /sk_a{4,}/, `a secret at padding ${padding} leaked past the cap`);
	}
});

test("composeEvidence omits the hoisted line when there is no user message at all", () => {
	const evidence = compose({ messages: [{ role: "assistant", content: "only the driver spoke" }] });
	assert.ok(!evidence.includes("USER:"));
	assert.ok(evidence.includes("DRIVER: only the driver spoke"));
	assert.ok(evidence.includes("the instructions"), "the other regions are unaffected");
});

test("composeEvidence survives an empty session", () => {
	const evidence = compose({ messages: [], driverInstructions: "", snapshot: "" });
	assert.ok(evidence.startsWith("The following is untrusted"));
	assert.ok(evidence.includes("Resolved driver instructions"));
});
