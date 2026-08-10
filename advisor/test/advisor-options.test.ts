import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { advisorCompletionOptions, isSupportedThinking } from "../advisor-options.ts";

function model(api: Model<any>["api"], reasoning = true): Model<any> {
	return {
		provider: "test", id: "advisor", name: "advisor", api, baseUrl: "http://test", reasoning,
		input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 2_000,
	};
}

test("maps verified thinking APIs and rejects unsupported models", () => {
	const signal = new AbortController().signal;
	const openAi = model("openai-responses");
	assert.equal(isSupportedThinking(openAi, "high"), true);
	const options = advisorCompletionOptions(openAi, "high", 100, signal);
	assert.ok(options && "reasoningEffort" in options && options.reasoningEffort === "high" && options.toolChoice === "required");
	const google = advisorCompletionOptions(model("google-generative-ai"), "high", 100, signal);
	assert.ok(google && "thinking" in google && google.thinking.level === "HIGH");
	assert.equal(advisorCompletionOptions(model("pi-messages"), "high", 100, signal), undefined);
	assert.equal(advisorCompletionOptions(model("openai-responses", false), "high", 100, signal), undefined);
});

test("forces a tool call even when thinking is off", () => {
	const signal = new AbortController().signal;
	const cases: Array<[Model<any>["api"], "required" | "any"]> = [
		["openai-completions", "required"], ["openai-responses", "required"], ["openai-codex-responses", "required"],
		["azure-openai-responses", "required"], ["mistral-conversations", "required"], ["anthropic-messages", "any"],
		["bedrock-converse-stream", "any"], ["google-generative-ai", "any"], ["google-vertex", "any"],
	];
	for (const [api, expectedChoice] of cases) {
		const options = advisorCompletionOptions(model(api), "off", 100, signal);
		assert.ok(options && options.toolChoice === expectedChoice);
		assert.equal("reasoningEffort" in options || "thinkingEnabled" in options || "reasoning" in options || "thinking" in options, false);
	}
	assert.equal(advisorCompletionOptions(model("pi-messages"), "off", 100, signal), undefined);
});
