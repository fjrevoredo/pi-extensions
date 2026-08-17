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
	const queuedChoices: (string | ((choices: string[]) => string))[] = [];
	let selectCalls = 0;
	let lastChoices: string[] = [];

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
			async select(_prompt: string, choices: string[]) {
				selectCalls++;
				lastChoices = choices;
				const choice = queuedChoices.shift();
				assert.ok(choice, "ui.select was called with no queued choice");
				// The session-root option's label carries the directory it grants, so a test cannot
				// name it as a constant. Queue a picker instead and let it find the option.
				return typeof choice === "function" ? choice(choices) : choice;
			},
		},
	};

	return {
		steered,
		get selectCalls() {
			return selectCalls;
		},
		get lastChoices() {
			return lastChoices;
		},
		queue(...choices: (string | ((choices: string[]) => string))[]) {
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

// The point of the whole change: the four measured false positives reach the gate and produce no
// prompt at all, without any approval having been cached.
test("a removal confined to a throwaway directory is allowed without a prompt", async () => {
	const harness = createHarness();

	assert.equal(await harness.call("rm -rf /tmp/scratch && mkdir -p /tmp/scratch"), undefined);
	assert.equal(await harness.call("set -e\nrm -rf /tmp/venv\npython3 -m venv /tmp/venv"), undefined);
	assert.equal(harness.selectCalls, 0);
});

test("the exemption skips one rule rather than allowing the command", async () => {
	const harness = createHarness();
	harness.queue(BLOCK);

	const result: any = await harness.call("sudo rm -rf /tmp/scratch");

	assert.equal(result.block, true);
	// The removal rule stepped aside; the privilege rule is what the user is asked about.
	assert.match(result.reason, /privilege-sudo/);
});

test("still prompts for a removal outside a throwaway directory", async () => {
	const harness = createHarness();
	harness.queue(BLOCK);

	const result: any = await harness.call("rm -rf /tmp/scratch && rm -rf ~/Documents");

	assert.equal(result.block, true);
	assert.match(result.reason, /filesystem-rm-recursive/);
});

function pickOption(match: RegExp) {
	return (choices: string[]) => {
		const choice = choices.find((option) => match.test(option));
		assert.ok(choice, `no option matched ${match} in ${JSON.stringify(choices)}`);
		return choice;
	};
}

test("offers the session-root option only when a grant would cover the command", async () => {
	const harness = createHarness();
	harness.queue(ALLOW_ONCE, ALLOW_ONCE);

	await harness.call("rm -rf /Users/me/scratch/build");
	assert.deepEqual(harness.lastChoices, [
		ALLOW_ONCE,
		ALLOW_FOR_SESSION,
		"Allow this rule under /Users/me/scratch/build for this session",
		EXPLAIN,
		BLOCK,
	]);

	// A relative operand grants against a cwd the gate cannot see, so the four original options
	// are shown unchanged rather than a fifth that would grant nothing.
	await harness.call("rm -rf dist");
	assert.deepEqual(harness.lastChoices, [ALLOW_ONCE, ALLOW_FOR_SESSION, EXPLAIN, BLOCK]);
});

test("a granted root silences paths below it and nothing beside it", async () => {
	const harness = createHarness();
	harness.queue(pickOption(/^Allow this rule under /), BLOCK);

	assert.equal(await harness.call("rm -rf /Users/me/scratch/build"), undefined);
	assert.equal(harness.selectCalls, 1);

	// Below the granted root: no prompt, and no approval was cached for this command either.
	assert.equal(await harness.call("rm -rf /Users/me/scratch/build/sub"), undefined);
	assert.equal(harness.selectCalls, 1);

	// A sibling is a different directory and is still gated.
	const result: any = await harness.call("rm -rf /Users/me/scratch/other");
	assert.equal(harness.selectCalls, 2);
	assert.equal(result.block, true);
});

test("a granted root does not carry to another rule", async () => {
	const harness = createHarness();
	harness.queue(pickOption(/^Allow this rule under /), BLOCK);

	await harness.call("rm -rf /Users/me/scratch/build");

	// Same directory, different rule: the grant is bound to the rule it was given for (P5).
	const result: any = await harness.call("rmdir /Users/me/scratch/build");
	assert.equal(result.block, true);
	assert.match(result.reason, /filesystem-rmdir/);
});

test("clears granted roots on session shutdown", async () => {
	const harness = createHarness();
	harness.queue(pickOption(/^Allow this rule under /), BLOCK);

	await harness.call("rm -rf /Users/me/scratch/build");
	assert.equal(harness.selectCalls, 1);

	await harness.shutdown();

	const result: any = await harness.call("rm -rf /Users/me/scratch/build");
	assert.equal(harness.selectCalls, 2, "granted roots must not outlive the session");
	assert.equal(result.block, true);
});
