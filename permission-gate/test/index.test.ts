/**
 * Entrypoint harness test: drives the real permission-gate entrypoint with a fake `pi`,
 * no TUI and no pi runtime.
 *
 * test/core.test.ts covers rule *matching*. This file covers the *decisions* built on
 * top of it — allow, block, fail-closed, session-approval caching and its scoping.
 * Keep the two separate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import permissionGate from "../index.ts";

// The exact option strings the entrypoint defines. Asserting through these rather than
// through indexes means a reordering of the prompt cannot silently repoint a test.
const ALLOW_ONCE = "Allow once";
const ALLOW_FOR_SESSION = "Allow for this session";
const EXPLAIN = "Explain this command";
const BLOCK = "Block";

interface SteerMessage {
	text: string;
	options: unknown;
}

function createHarness(options: { hasUI?: boolean } = {}) {
	const handlers = new Map<string, (event: any, ctx?: any) => unknown>();
	const steered: SteerMessage[] = [];
	const queuedChoices: string[] = [];
	let selectCalls = 0;

	const pi = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(event, handler);
		},
		sendUserMessage(text: string, messageOptions: unknown) {
			steered.push({ text, options: messageOptions });
		},
	} as any;

	permissionGate(pi);

	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			async select(_prompt: string, _choices: string[]) {
				selectCalls++;
				const choice = queuedChoices.shift();
				assert.ok(choice, "ui.select was called with no queued choice");
				return choice;
			},
		},
	};

	return {
		steered,
		get selectCalls() {
			return selectCalls;
		},
		queue(...choices: string[]) {
			queuedChoices.push(...choices);
		},
		setHasUI(value: boolean) {
			ctx.hasUI = value;
		},
		async call(command: string, toolName = "bash") {
			const handler = handlers.get("tool_call");
			assert.ok(handler, "no tool_call handler was registered");
			return await handler({ toolName, input: { command } }, ctx);
		},
		async shutdown() {
			const handler = handlers.get("session_shutdown");
			assert.ok(handler, "no session_shutdown handler was registered");
			return await handler({}, ctx);
		},
	};
}

test("ignores tools other than bash without consulting the user", async () => {
	const harness = createHarness();

	assert.equal(await harness.call("rm -rf dist", "read"), undefined);
	assert.equal(harness.selectCalls, 0);
});

test("allows a benign command without consulting the user", async () => {
	const harness = createHarness();

	assert.equal(await harness.call("ls -la"), undefined);
	assert.equal(harness.selectCalls, 0);
});

test("fails closed when there is no UI to prompt with", async () => {
	const harness = createHarness({ hasUI: false });

	const result: any = await harness.call("rm -rf dist");

	assert.equal(result.block, true);
	// The matched rule id is what makes the block searchable and explainable (P2).
	assert.match(result.reason, /filesystem-rm-recursive/);
	assert.equal(harness.selectCalls, 0);
});

test("allow once lets the call through without caching the approval", async () => {
	const harness = createHarness();
	harness.queue(ALLOW_ONCE, ALLOW_ONCE);

	assert.equal(await harness.call("rm -rf dist"), undefined);
	assert.equal(harness.selectCalls, 1);

	assert.equal(await harness.call("rm -rf dist"), undefined);
	assert.equal(harness.selectCalls, 2, "an identical command must prompt again");
});

test("allow for this session caches the approval", async () => {
	const harness = createHarness();
	harness.queue(ALLOW_FOR_SESSION);

	assert.equal(await harness.call("rm -rf dist"), undefined);
	assert.equal(harness.selectCalls, 1);

	assert.equal(await harness.call("rm -rf dist"), undefined);
	assert.equal(harness.selectCalls, 1, "an identical command must not prompt again");
});

test("explain blocks the call and steers the agent exactly once", async () => {
	const harness = createHarness();
	harness.queue(EXPLAIN);

	const result: any = await harness.call("rm -rf dist");

	assert.equal(result.block, true);
	assert.equal(harness.steered.length, 1);
	assert.deepEqual(harness.steered[0]!.options, { deliverAs: "steer" });
	assert.match(harness.steered[0]!.text, /filesystem-rm-recursive/);
});

test("block denies the call", async () => {
	const harness = createHarness();
	harness.queue(BLOCK);

	const result: any = await harness.call("rm -rf dist");

	assert.equal(result.block, true);
	assert.match(result.reason, /filesystem-rm-recursive/);
	assert.equal(harness.steered.length, 0);
});

test("keeps the session approval key narrower than the matched rule", async () => {
	const harness = createHarness();
	harness.queue(ALLOW_FOR_SESSION, ALLOW_FOR_SESSION);

	await harness.call("rm -rf dist");
	assert.equal(harness.selectCalls, 1);

	// Same rule, different command: approving one must never widen into a
	// category-level bypass (P5).
	await harness.call("rm -rf build");
	assert.equal(harness.selectCalls, 2);
});

test("keys the approval on the normalized command", async () => {
	const harness = createHarness();
	harness.queue(ALLOW_FOR_SESSION);

	await harness.call("rm -rf dist");
	assert.equal(harness.selectCalls, 1);

	// Normalization runs before matching and before keying, using the same
	// normalizer for both (P6).
	assert.equal(await harness.call("rm   -rf    dist"), undefined);
	assert.equal(harness.selectCalls, 1);
});

test("clears cached approvals on session shutdown", async () => {
	const harness = createHarness();
	harness.queue(ALLOW_FOR_SESSION, ALLOW_FOR_SESSION);

	await harness.call("rm -rf dist");
	assert.equal(harness.selectCalls, 1);

	await harness.shutdown();

	await harness.call("rm -rf dist");
	assert.equal(harness.selectCalls, 2, "approvals must not outlive the session");
});
