import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AdvisorConfig, Advice } from "./contracts.ts";
import { AdviceSchema, validateAdvice } from "./contracts.ts";
import { advisorCompletionOptions } from "./advisor-options.ts";
import { createPathPolicy } from "./path-policy.ts";
import { executeRepositoryTool } from "./repository-tools.ts";

const privateTools = [
	{ name: "read", description: "Read one permitted text file. Output is capped and redacted.", parameters: Type.Object({ path: Type.String() }) },
	{ name: "grep", description: "Search permitted repository text files with a regular expression.", parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })) }) },
	{ name: "find", description: "List permitted repository paths under a directory.", parameters: Type.Object({ path: Type.Optional(Type.String()), maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })) }) },
	{ name: "ls", description: "List one permitted repository directory.", parameters: Type.Object({ path: Type.Optional(Type.String()) }) },
	{ name: "submit_advice", description: "Submit exactly one final advice object. Required fields: outcome (on_track, course_correct, not_ready, stop), non-empty summary, non-empty rationale, recommendedActions, risks with severity and description, verification, assumptions, and confidence. Use an empty risks array only for on_track with no concrete risk. This ends the consultation.", parameters: Type.Object({ advice: AdviceSchema }, { additionalProperties: false }) },
] as const;
export const PRIVATE_TOOL_NAMES = privateTools.map((tool) => tool.name);

function addUsage(total: Usage | undefined, usage: Usage | undefined): Usage | undefined {
	if (!usage) return total;
	if (!total) return { ...usage, cost: { ...usage.cost } };
	return {
		input: total.input + usage.input, output: total.output + usage.output, cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite, cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0), reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0), totalTokens: total.totalTokens + usage.totalTokens,
		cost: { input: total.cost.input + usage.cost.input, output: total.cost.output + usage.cost.output, cacheRead: total.cost.cacheRead + usage.cost.cacheRead, cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite, total: total.cost.total + usage.cost.total },
	};
}

function toolResult(id: string, name: string, text: string) {
	return { role: "toolResult" as const, toolCallId: id, toolName: name, content: [{ type: "text" as const, text }], isError: false, timestamp: Date.now() };
}

interface CompletionRegistry {
	complete(model: Model<Api>, context: Context, options?: unknown): Promise<AssistantMessage>;
}

export async function runAdvisorLoop(input: {
	registry: CompletionRegistry;
	model: Model<Api>;
	config: AdvisorConfig;
	root: string;
	systemPrompt: string;
	evidence: string;
	signal?: AbortSignal;
}): Promise<{ advice?: Advice; usage?: Usage; readOnlyToolCalls: number; failure?: "aborted" | "timeout" | "invalid_response" | "provider_error" }> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), input.config.limits.timeoutMs);
	const signal = AbortSignal.any(input.signal ? [input.signal, timeout.signal] : [timeout.signal]);
	const options = advisorCompletionOptions(input.model, input.config.thinking, input.config.limits.maxAdvisorOutputTokens, signal);
	if (!options) return { readOnlyToolCalls: 0, failure: "invalid_response" };
	const context: Context = { systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.evidence, timestamp: Date.now() }], tools: [...privateTools] };
	const policy = createPathPolicy(input.root, input.config.security.additionalProtectedPaths, input.config.security.redactKnownSecrets);
	let usage: Usage | undefined;
	let readOnlyToolCalls = 0;
	let submitted = false;
	let invalidSubmissions = 0;
	let correctionOnly = false;
	try {
		for (let turn = 0; turn < input.config.limits.maxAdvisorTurns; turn += 1) {
			signal.throwIfAborted();
			const response = await input.registry.complete(input.model, context, options);
			usage = addUsage(usage, response.usage);
			context.messages.push(response);
			const calls = response.content.filter((part: unknown): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => Boolean(part && typeof part === "object" && (part as { type?: string }).type === "toolCall"));
			if (calls.length === 0) return { usage, readOnlyToolCalls, failure: "invalid_response" };
			const submissions = calls.filter((call) => call.name === "submit_advice");
			if (submissions.length > 1 || (submissions.length === 1 && calls.length !== 1)) return { usage, readOnlyToolCalls, failure: "invalid_response" };
			if (correctionOnly && (calls.length !== 1 || calls[0]?.name !== "submit_advice")) return { usage, readOnlyToolCalls, failure: "invalid_response" };
			for (const call of calls) {
				if (!PRIVATE_TOOL_NAMES.includes(call.name as (typeof PRIVATE_TOOL_NAMES)[number])) return { usage, readOnlyToolCalls, failure: "invalid_response" };
				if (call.name === "submit_advice") {
					if (submitted) return { usage, readOnlyToolCalls, failure: "invalid_response" };
					submitted = true;
					const advice = validateAdvice(call.arguments.advice);
					if (!advice) {
						invalidSubmissions += 1;
						if (invalidSubmissions > 1) return { usage, readOnlyToolCalls, failure: "invalid_response" };
						context.messages.push(toolResult(call.id, call.name, "Advice was not accepted because one or more required fields were missing or invalid. Submit one complete advice object again. Do not call repository tools."));
						correctionOnly = true;
						submitted = false;
						continue;
					}
					return { advice, usage, readOnlyToolCalls };
				}
				if (call.name !== "read" && call.name !== "grep" && call.name !== "find" && call.name !== "ls") return { usage, readOnlyToolCalls, failure: "invalid_response" };
				if (readOnlyToolCalls >= input.config.limits.maxReadOnlyToolCalls) {
					context.messages.push(toolResult(call.id, call.name, "Read-only tool budget is exhausted. Submit advice now without another repository tool call."));
					continue;
				}
				readOnlyToolCalls += 1;
				const output = await executeRepositoryTool(policy, call.name, call.arguments, signal);
				context.messages.push(toolResult(call.id, call.name, output));
			}
		}
		return { usage, readOnlyToolCalls, failure: "invalid_response" };
	} catch (error) {
		if (signal.aborted) return { usage, readOnlyToolCalls, failure: timeout.signal.aborted ? "timeout" : "aborted" };
		return { usage, readOnlyToolCalls, failure: "provider_error" };
	} finally { clearTimeout(timer); }
}
