import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { AdvisorConfig, Advice } from "./contracts.ts";
import { validateAdvice } from "./contracts.ts";
import { advisorCompletionOptions } from "./advisor-options.ts";
import type { PathPolicy } from "./path-policy.ts";
import { createResolvedPathPolicy } from "./path-access.ts";
import { executeRepositoryTool } from "./repository-tools.ts";
import {
	type AdvisorToolCall,
	classifyTurn,
	isPrivateTool,
	isRepositoryTool,
	PRIVATE_TOOLS,
} from "./turn-policy.ts";

const INVALID_SUBMISSION_NOTICE =
	"Advice was not accepted because one or more required fields were missing or invalid. Submit one complete advice object again. Do not call repository tools.";
const READ_BUDGET_NOTICE = "Read-only tool budget is exhausted. Submit advice now without another repository tool call.";

function addUsage(total: Usage | undefined, usage: Usage | undefined): Usage | undefined {
	if (!usage) return total;
	if (!total) return { ...usage, cost: { ...usage.cost } };
	return {
		input: total.input + usage.input, output: total.output + usage.output, cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite, cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0), reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0), totalTokens: total.totalTokens + usage.totalTokens,
		cost: { input: total.cost.input + usage.cost.input, output: total.cost.output + usage.cost.output, cacheRead: total.cost.cacheRead + usage.cost.cacheRead, cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite, total: total.cost.total + usage.cost.total },
	};
}

function toolResult(id: string, name: string, text: string, now: () => number) {
	return { role: "toolResult" as const, toolCallId: id, toolName: name, content: [{ type: "text" as const, text }], isError: false, timestamp: now() };
}

interface CompletionRegistry {
	complete(model: Model<Api>, context: Context, options?: unknown): Promise<AssistantMessage>;
}

/**
 * Execute one turn's repository calls in order, appending each result to the
 * conversation. Returns the new running count, or `invalid` for a call the turn
 * policy does not admit.
 *
 * Calls are executed as they are walked, so a valid read followed by an unknown
 * name leaves the read run and counted. That is pre-existing behaviour and is
 * deliberately preserved (§19); turn-policy.ts explains why it is not hoisted.
 */
async function runRepositoryCalls(input: {
	calls: AdvisorToolCall[];
	policy: PathPolicy;
	context: Context;
	readOnlyToolCalls: number;
	maxReadOnlyToolCalls: number;
	signal: AbortSignal;
	now: () => number;
}): Promise<{ readOnlyToolCalls: number; invalid?: true }> {
	let readOnlyToolCalls = input.readOnlyToolCalls;
	for (const call of input.calls) {
		if (!isPrivateTool(call.name) || !isRepositoryTool(call.name)) return { readOnlyToolCalls, invalid: true };
		if (readOnlyToolCalls >= input.maxReadOnlyToolCalls) {
			input.context.messages.push(toolResult(call.id, call.name, READ_BUDGET_NOTICE, input.now));
			continue;
		}
		readOnlyToolCalls += 1;
		const output = await executeRepositoryTool(input.policy, call.name, call.arguments, input.signal);
		input.context.messages.push(toolResult(call.id, call.name, output, input.now));
	}
	return { readOnlyToolCalls };
}

/**
 * Orchestration only: set up the budget and the abort wiring, then walk turns.
 * Every decision it makes is delegated — the turn policy to turn-policy.ts, the
 * path filter to path-policy.ts, advice validation to contracts.ts.
 *
 * Deviates from F5's ~40 lines: what remains is five pieces of loop state
 * (usage, read count, and the three submission flags) that a further split would
 * have to thread through helpers and read back, which is more error-prone than
 * the sequence it replaces, not less.
 */
export async function runAdvisorLoop(input: {
	registry: CompletionRegistry;
	model: Model<Api>;
	config: AdvisorConfig;
	root: string;
	/** pi's agent directory, so the path policy can protect it without reading pi state itself (S2). */
	agentDirectory: string;
	systemPrompt: string;
	evidence: string;
	signal?: AbortSignal;
	/** Injected clock (S6). Only ever stamps message timestamps. */
	now?: () => number;
}): Promise<{ advice?: Advice; usage?: Usage; readOnlyToolCalls: number; failure?: "aborted" | "timeout" | "invalid_response" | "provider_error" }> {
	const now = input.now ?? Date.now;
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), input.config.limits.timeoutMs);
	const signal = AbortSignal.any(input.signal ? [input.signal, timeout.signal] : [timeout.signal]);
	const options = advisorCompletionOptions(input.model, input.config.thinking, input.config.limits.maxAdvisorOutputTokens, signal);
	if (!options) return { readOnlyToolCalls: 0, failure: "invalid_response" };
	const context: Context = {
		systemPrompt: input.systemPrompt,
		messages: [{ role: "user", content: input.evidence, timestamp: now() }],
		tools: [...PRIVATE_TOOLS],
	};
	// Canonicalized once, here, rather than re-derived per call: the root has to be
	// the same string the tools compare against, or displayPath degrades to bare
	// basenames and the agent-directory guard silently stops matching (P6).
	const policy = await createResolvedPathPolicy({
		root: input.root,
		agentDirectory: input.agentDirectory,
		additionalProtectedPaths: input.config.security.additionalProtectedPaths,
		redactKnownSecrets: input.config.security.redactKnownSecrets,
	});
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
			const turnResult = classifyTurn(response.content, { correctionOnly });
			if (turnResult.kind === "invalid") return { usage, readOnlyToolCalls, failure: "invalid_response" };

			if (turnResult.kind === "submit") {
				const call = turnResult.call;
				if (submitted) return { usage, readOnlyToolCalls, failure: "invalid_response" };
				submitted = true;
				const advice = validateAdvice(call.arguments.advice);
				if (advice) return { advice, usage, readOnlyToolCalls };
				invalidSubmissions += 1;
				if (invalidSubmissions > 1) return { usage, readOnlyToolCalls, failure: "invalid_response" };
				context.messages.push(toolResult(call.id, call.name, INVALID_SUBMISSION_NOTICE, now));
				correctionOnly = true;
				submitted = false;
				continue;
			}

			const executed = await runRepositoryCalls({
				calls: turnResult.calls,
				policy,
				context,
				readOnlyToolCalls,
				maxReadOnlyToolCalls: input.config.limits.maxReadOnlyToolCalls,
				signal,
				now,
			});
			readOnlyToolCalls = executed.readOnlyToolCalls;
			if (executed.invalid) return { usage, readOnlyToolCalls, failure: "invalid_response" };
		}
		return { usage, readOnlyToolCalls, failure: "invalid_response" };
	} catch {
		if (signal.aborted) return { usage, readOnlyToolCalls, failure: timeout.signal.aborted ? "timeout" : "aborted" };
		return { usage, readOnlyToolCalls, failure: "provider_error" };
	} finally { clearTimeout(timer); }
}
