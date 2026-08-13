import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAdvisorLoop } from "../advisor-loop.ts";
import { FAILURE_MESSAGES } from "../consultation.ts";
import { defaultConfig } from "../contracts.ts";

// Injected rather than read from pi (T7). The policy only does path arithmetic
// with it, so this never has to exist on disk.
const agentDirectory = join(tmpdir(), "advisor-tests-agent-dir");

const model = {
	provider: "test",
	id: "advisor",
	name: "advisor",
	api: "openai-completions",
	baseUrl: "http://test",
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 2_000,
};
const validAdvice = {
	outcome: "on_track",
	summary: "The current direction is sound.",
	rationale: ["The evidence matches the requested design."],
	recommendedActions: [],
	risks: [],
	verification: ["Run tests."],
	assumptions: [],
	confidence: "medium",
};
const baseConfig = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type TextPart = { type: "text"; text: string };

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallPart => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const submitCall = (id: string, advice: unknown) => toolCall(id, "submit_advice", { advice });
const textPart = (text: string): TextPart => ({ type: "text", text });

/**
 * One scripted assistant turn. `stopReason` is the field the truncation branch
 * reads before anything else, so it is spelled out per turn rather than defaulted
 * away.
 */
function assistantTurn(content: (ToolCallPart | TextPart)[], stopReason: "toolUse" | "length") {
	return {
		role: "assistant" as const,
		api: "openai-completions" as const,
		provider: "test",
		model: "advisor",
		stopReason,
		timestamp: Date.now(),
		content,
		usage: NO_USAGE,
	};
}

/** A registry that replays scripted turns and records the context of every request. */
function scripted(turns: ReturnType<typeof assistantTurn>[]) {
	const requests: Array<readonly unknown[]> = [];
	return {
		requests,
		registry: {
			async complete(_model: unknown, context: { messages: readonly unknown[] }) {
				requests.push([...context.messages]);
				const next = turns.shift();
				if (!next) throw new Error("the loop asked for more turns than the test scripted");
				return next;
			},
		},
	};
}

type LoopInput = Parameters<typeof runAdvisorLoop>[0];

const loop = (registry: LoopInput["registry"], limits: Partial<LoopInput["config"]["limits"]> = {}) =>
	runAdvisorLoop({
		registry,
		model,
		config: { ...baseConfig, limits: { ...baseConfig.limits, ...limits } },
		root: process.cwd(),
		agentDirectory,
		systemPrompt: "policy",
		evidence: "task",
	});

test("runs only private read tools then returns validated advice", async () => {
	let calls = 0;
	const registry = {
		async complete() {
			calls += 1;
			const base = {
				role: "assistant" as const,
				api: "openai-completions" as const,
				provider: "test",
				model: "advisor",
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			return calls === 1
				? {
						...base,
						content: [
							{ type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "README.md" } },
						],
					}
				: {
						...base,
						content: [
							{
								type: "toolCall" as const,
								id: "submit-1",
								name: "submit_advice",
								arguments: { advice: validAdvice },
							},
						],
					};
		},
	};
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({
		registry,
		model,
		config,
		root: process.cwd(),
		agentDirectory,
		systemPrompt: "policy",
		evidence: "task",
	});
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(result.readOnlyToolCalls, 1);
	assert.equal(result.usage?.totalTokens, 4);
});

test("allows one corrected final submission without exposing invalid advice", async () => {
	let turn = 0;
	const registry = {
		async complete() {
			turn += 1;
			const base = {
				role: "assistant" as const,
				api: "openai-completions" as const,
				provider: "test",
				model: "advisor",
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			return {
				...base,
				content: [
					{
						type: "toolCall" as const,
						id: `submit-${turn}`,
						name: "submit_advice",
						arguments: { advice: turn === 1 ? {} : validAdvice },
					},
				],
			};
		},
	};
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({
		registry,
		model,
		config,
		root: process.cwd(),
		agentDirectory,
		systemPrompt: "policy",
		evidence: "task",
	});
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(turn, 2);
});

test("rejects every non-submission call during the correction turn", async () => {
	let turn = 0;
	const registry = {
		async complete() {
			turn += 1;
			const base = {
				role: "assistant" as const,
				api: "openai-completions" as const,
				provider: "test",
				model: "advisor",
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const content =
				turn === 1
					? [{ type: "toolCall" as const, id: "invalid", name: "submit_advice", arguments: { advice: {} } }]
					: [{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } }];
			return { ...base, content };
		},
	};
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({
		registry,
		model,
		config,
		root: process.cwd(),
		agentDirectory,
		systemPrompt: "policy",
		evidence: "task",
	});
	assert.equal(result.failure, "invalid_response");
	assert.equal(result.readOnlyToolCalls, 0);
});

test("enforces the read cap while allowing a final submission", async () => {
	let turn = 0;
	const registry = {
		async complete() {
			turn += 1;
			const base = {
				role: "assistant" as const,
				api: "openai-completions" as const,
				provider: "test",
				model: "advisor",
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			if (turn < 3)
				return {
					...base,
					content: [
						{ type: "toolCall" as const, id: `read-${turn}`, name: "read", arguments: { path: "README.md" } },
					],
				};
			return {
				...base,
				content: [
					{ type: "toolCall" as const, id: "submit", name: "submit_advice", arguments: { advice: validAdvice } },
				],
			};
		},
	};
	const config = {
		...defaultConfig(),
		enabled: true,
		model: "test/advisor",
		thinking: "high" as const,
		limits: { ...defaultConfig().limits, maxReadOnlyToolCalls: 1 },
	};
	const result = await runAdvisorLoop({
		registry,
		model,
		config,
		root: process.cwd(),
		agentDirectory,
		systemPrompt: "policy",
		evidence: "task",
	});
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(result.readOnlyToolCalls, 1);
});

test("stops before a completion request when the parent aborts", async () => {
	let called = false;
	const registry = {
		async complete() {
			called = true;
			throw new Error("must not run");
		},
	};
	const controller = new AbortController();
	controller.abort();
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	const result = await runAdvisorLoop({
		registry,
		model,
		config,
		root: process.cwd(),
		agentDirectory,
		systemPrompt: "policy",
		evidence: "task",
		signal: controller.signal,
	});
	assert.equal(result.failure, "aborted");
	assert.equal(called, false);
});

/**
 * The 2026-08-13 regression, reproduced as it actually happened. A real
 * consultation read five files and then ran out of output tokens part-way through
 * its submission: the provider returned `stopReason: "length"` and an *unusable*
 * turn — the incomplete `submit_advice` call never arrived as a tool call at all,
 * so `classifyTurn` saw no call to admit and the loop reported `invalid_response`
 * on the spot. The existing repair round only covers a well-formed submission that
 * fails validation, so the likeliest real failure had the only path with no retry.
 */
test("retries once after a length stop and returns the advice the retry submits", async () => {
	const { registry, requests } = scripted([
		assistantTurn([toolCall("read-1", "read", { path: "README.md" })], "toolUse"),
		assistantTurn([textPart("The requested prompt wording would cause spurious permission pro")], "length"),
		assistantTurn([submitCall("submit-2", validAdvice)], "toolUse"),
	]);
	const result = await loop(registry);
	assert.equal(result.advice?.outcome, "on_track", "the retry's advice is returned, not invalid_response");
	assert.equal(result.failure, undefined);
	assert.equal(result.readOnlyToolCalls, 1, "the read the truncated turn had already spent still counts");
	assert.equal(requests.length, 3, "exactly one retry, not a fresh consultation");
});

test("a second length stop is a truncation failure, not an invalid response", async () => {
	const { registry, requests } = scripted([
		assistantTurn([textPart("cut off once")], "length"),
		assistantTurn([textPart("cut off twice")], "length"),
	]);
	const result = await loop(registry);
	assert.equal(result.failure, "truncated");
	assert.equal(requests.length, 2, "the second length stop ends it rather than retrying again");
	// T6: the driver-facing sentence for this outcome, verbatim. It is deliberately
	// not invalid_response's, because the remedy is raising maxAdvisorOutputTokens.
	assert.equal(
		FAILURE_MESSAGES[result.failure],
		"Advisor response exceeded its output budget. Continue with local evidence.",
	);
});

test("the truncated turn never enters the conversation the retry is built from", async () => {
	// The other shape of a length stop: the partial call did arrive as a toolCall
	// part. Appending that turn would leave a toolCall with no matching toolResult,
	// which OpenAI-shaped APIs reject on the next request. Asserted rather than
	// trusted: this is the reason the stopReason check precedes the messages.push.
	const { registry, requests } = scripted([
		assistantTurn([submitCall("cut-1", { outcome: "course_correct", summary: "cut off here" })], "length"),
		assistantTurn([submitCall("submit-2", validAdvice)], "toolUse"),
	]);
	const result = await loop(registry);
	assert.equal(result.advice?.outcome, "on_track");
	const retry = JSON.stringify(requests[1]);
	assert.ok(!retry.includes("cut-1"), "the partial tool call is dropped");
	assert.ok(!retry.includes("cut off here"), "and so is the text it was cut off inside");
	assert.ok(retry.includes("cut off by the output limit"), "the advisor is told what happened instead");
	// The notice is user-role, so nothing in the conversation claims to be an
	// assistant turn or a result for a call that was never completed.
	assert.deepEqual(
		(requests[1] as Array<{ role: string }>).map((message) => message.role),
		["user", "user"],
	);
});

test("a length stop restricts the retry to a lone submission", async () => {
	const { registry, requests } = scripted([
		assistantTurn([textPart("cut off")], "length"),
		assistantTurn([toolCall("read-1", "read", { path: "README.md" })], "toolUse"),
	]);
	const result = await loop(registry);
	assert.equal(requests.length, 2, "the retry happened");
	assert.equal(result.failure, "invalid_response", "and correctionOnly was in force for it");
	assert.equal(result.readOnlyToolCalls, 0, "so the refused read never ran");
});

test("the truncation and correction budgets are counted independently", async () => {
	// One of each is survivable: a length stop and then a schema-rejected submission
	// still leaves the advisor a turn to get it right. Sharing one counter would end
	// the consultation on the second, unrelated, mistake.
	const { registry } = scripted([
		assistantTurn([textPart("cut off")], "length"),
		assistantTurn([submitCall("invalid-1", {})], "toolUse"),
		assistantTurn([submitCall("submit-1", validAdvice)], "toolUse"),
	]);
	const result = await loop(registry);
	assert.equal(result.advice?.outcome, "on_track");
	assert.equal(result.failure, undefined);
});

test("rejects unknown or mixed private tool calls", async () => {
	const config = { ...defaultConfig(), enabled: true, model: "test/advisor", thinking: "high" as const };
	for (const content of [
		[{ type: "toolCall" as const, id: "bad", name: "bash", arguments: {} }],
		[
			{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } },
			{ type: "toolCall" as const, id: "submit", name: "submit_advice", arguments: { advice: validAdvice } },
		],
	]) {
		const registry = {
			async complete() {
				return {
					role: "assistant" as const,
					api: "openai-completions" as const,
					provider: "test",
					model: "advisor",
					stopReason: "toolUse" as const,
					timestamp: Date.now(),
					content,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		};
		const result = await runAdvisorLoop({
			registry,
			model,
			config,
			root: process.cwd(),
			agentDirectory,
			systemPrompt: "policy",
			evidence: "task",
		});
		assert.equal(result.failure, "invalid_response");
	}
});
