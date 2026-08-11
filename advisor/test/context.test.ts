import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvisorContext } from "../context.ts";
import { SYSTEM_PROMPT } from "../contracts.ts";

/**
 * The pi-facing shell around evidence assembly. Everything it decides is
 * delegated to evidence.ts, so what is left to assert is the wiring: that it asks
 * pi for the right things, in the right order, and that its one defaulted
 * parameter defaults the safe way.
 *
 * The plan that promoted this extension recorded `context.ts` as having no tests
 * at all; this is that gap closed.
 */

const ENTRIES = [
	{ id: "1", parentId: null, type: "message", message: { role: "user", content: "the question", timestamp: 1 } },
	{
		id: "2",
		parentId: "1",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "the reply" }], timestamp: 2 },
	},
];

/** A fake ExtensionContext that records the order it was asked for things. */
function fakeContext(calls: string[]) {
	return {
		sessionManager: {
			getEntries: () => {
				calls.push("getEntries");
				return ENTRIES;
			},
			getLeafId: () => "2",
		},
		getSystemPrompt: () => {
			calls.push("getSystemPrompt");
			return "resolved driver instructions";
		},
	} as never;
}

test("returns the advisor's system prompt unchanged, not a rebuilt copy", async () => {
	// The prompt is half of the advisor-facing contract (the other half is
	// AdviceSchema), so it has to be the constant, not a reconstruction of it.
	const result = await buildAdvisorContext(fakeContext([]), 96_000, async () => "snapshot");
	assert.equal(result.systemPrompt, SYSTEM_PROMPT);
});

test("hands the session, the driver instructions and the snapshot to the composer", async () => {
	const result = await buildAdvisorContext(fakeContext([]), 96_000, async () => "status:\nM a.ts");
	assert.ok(result.evidence.includes("USER: the question"), "the session reached the composer");
	assert.ok(result.evidence.includes("DRIVER: the reply"));
	assert.ok(result.evidence.includes("resolved driver instructions"), "ctx.getSystemPrompt() was used");
	assert.ok(result.evidence.includes("status:\nM a.ts"), "the caller's snapshot was used");
});

test("asks pi for the session before running the snapshot command", async () => {
	// Order is behaviour, not style: the snapshot is a `pi.exec` the caller owns,
	// and reading the session first means the evidence describes the state the
	// snapshot was taken against rather than one turn later.
	const calls: string[] = [];
	await buildAdvisorContext(fakeContext(calls), 96_000, async () => {
		calls.push("gitSnapshot");
		return "snapshot";
	});
	assert.deepEqual(calls, ["getEntries", "gitSnapshot", "getSystemPrompt"]);
});

test("redaction defaults to on", async () => {
	// The one defaulted parameter, and the direction matters: a default of `false`
	// would ship secrets from any caller that forgot the argument. index.ts always
	// passes the configured value, so this default is only ever a backstop — which
	// is exactly why nothing else would catch it changing.
	const secret = "token=sk_abcdefghijklmnop";
	const defaulted = await buildAdvisorContext(fakeContext([]), 96_000, async () => secret);
	assert.match(defaulted.evidence, /REDACTED_SECRET/);
	assert.doesNotMatch(defaulted.evidence, /sk_abcdefghijklmnop/);

	const off = await buildAdvisorContext(fakeContext([]), 96_000, async () => secret, false);
	assert.match(off.evidence, /sk_abcdefghijklmnop/, "and it is still a choice the caller can make");
});

test("passes the byte cap through", async () => {
	const long = await buildAdvisorContext(fakeContext([]), 4_096, async () => "x".repeat(20_000));
	assert.ok(Buffer.byteLength(long.evidence) < 20_000, "the cap reached the composer");
	const larger = await buildAdvisorContext(fakeContext([]), 96_000, async () => "x".repeat(20_000));
	assert.ok(
		Buffer.byteLength(larger.evidence) > Buffer.byteLength(long.evidence),
		"a larger cap keeps more, so the value is used rather than ignored",
	);
});
