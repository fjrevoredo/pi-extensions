import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../contracts.ts";
import { runAdvisorLoop } from "../advisor-loop.ts";

// Injected rather than read from pi (T7). The policy only does path arithmetic
// with it, so this never has to exist on disk.
const agentDirectory = join(tmpdir(), "advisor-tests-agent-dir");

const model = {
	provider: "test", id: "advisor", name: "advisor", api: "openai-completions", baseUrl: "http://test", reasoning: true,
	input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 2_000,
};
const validAdvice = { outcome: "on_track", summary: "The current direction is sound.", rationale: ["The evidence matches the requested design."], recommendedActions: [], risks: [], verification: ["Run tests."], assumptions: [], confidence: "medium" };

test("runs only private read tools then returns validated advice", async () => {
	let calls = 0;
	const registry = { async complete() {
		calls += 1;
		const base = { role: "assistant" as const, api: "openai-completions" as const, provider: "test", model: "advisor", stopReason: "toolUse" as const, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		return calls === 1
			? { ...base, content: [{ type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "README.md" } }] }
			: { ...base, content: [{ type: "toolCall" as const, id: "submit-1", name: "submit_advice", arguments: { advice: validAdvice } }] };
	} };
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({ registry, model, config, root: process.cwd(), agentDirectory, systemPrompt: "policy", evidence: "task" });
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(result.readOnlyToolCalls, 1);
	assert.equal(result.usage?.totalTokens, 4);
});

test("allows one corrected final submission without exposing invalid advice", async () => {
	let turn = 0;
	const registry = { async complete() {
		turn += 1;
		const base = { role: "assistant" as const, api: "openai-completions" as const, provider: "test", model: "advisor", stopReason: "toolUse" as const, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		return { ...base, content: [{ type: "toolCall" as const, id: `submit-${turn}`, name: "submit_advice", arguments: { advice: turn === 1 ? {} : validAdvice } }] };
	} };
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({ registry, model, config, root: process.cwd(), agentDirectory, systemPrompt: "policy", evidence: "task" });
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(turn, 2);
});

test("rejects every non-submission call during the correction turn", async () => {
	let turn = 0;
	const registry = { async complete() {
		turn += 1;
		const base = { role: "assistant" as const, api: "openai-completions" as const, provider: "test", model: "advisor", stopReason: "toolUse" as const, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const content = turn === 1
			? [{ type: "toolCall" as const, id: "invalid", name: "submit_advice", arguments: { advice: {} } }]
			: [{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } }];
		return { ...base, content };
	} };
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({ registry, model, config, root: process.cwd(), agentDirectory, systemPrompt: "policy", evidence: "task" });
	assert.equal(result.failure, "invalid_response");
	assert.equal(result.readOnlyToolCalls, 0);
});

test("enforces the read cap while allowing a final submission", async () => {
	let turn = 0;
	const registry = { async complete() {
		turn += 1;
		const base = { role: "assistant" as const, api: "openai-completions" as const, provider: "test", model: "advisor", stopReason: "toolUse" as const, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		if (turn < 3) return { ...base, content: [{ type: "toolCall" as const, id: `read-${turn}`, name: "read", arguments: { path: "README.md" } }] };
		return { ...base, content: [{ type: "toolCall" as const, id: "submit", name: "submit_advice", arguments: { advice: validAdvice } }] };
	} };
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const, limits: { ...defaultConfig().limits, maxReadOnlyToolCalls: 1 } };
	const result = await runAdvisorLoop({ registry, model, config, root: process.cwd(), agentDirectory, systemPrompt: "policy", evidence: "task" });
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(result.readOnlyToolCalls, 1);
});

test("stops before a completion request when the parent aborts", async () => {
	let called = false;
	const registry = { async complete() { called = true; throw new Error("must not run"); } };
	const controller = new AbortController();
	controller.abort();
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({ registry, model, config, root: process.cwd(), agentDirectory, systemPrompt: "policy", evidence: "task", signal: controller.signal });
	assert.equal(result.failure, "aborted");
	assert.equal(called, false);
});

test("rejects unknown or mixed private tool calls", async () => {
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	for (const content of [
		[{ type: "toolCall" as const, id: "bad", name: "bash", arguments: {} }],
		[{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } }, { type: "toolCall" as const, id: "submit", name: "submit_advice", arguments: { advice: validAdvice } }],
	]) {
		const registry = { async complete() { return { role: "assistant" as const, api: "openai-completions" as const, provider: "test", model: "advisor", stopReason: "toolUse" as const, timestamp: Date.now(), content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; } };
		const result = await runAdvisorLoop({ registry, model, config, root: process.cwd(), agentDirectory, systemPrompt: "policy", evidence: "task" });
		assert.equal(result.failure, "invalid_response");
	}
});
