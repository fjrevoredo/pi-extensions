import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { advisorCompletionOptions } from "./advisor-options.ts";
import type { Advice, AdvisorConfig } from "./contracts.ts";
import { validateAdvice } from "./contracts.ts";
import { createResolvedPathPolicy } from "./path-access.ts";
import type { PathPolicy } from "./path-policy.ts";
import { executeRepositoryTool } from "./repository-tools.ts";
import {
	type AdvisorToolCall,
	classifyTurn,
	type InvalidTurnReason,
	isPrivateTool,
	isRepositoryTool,
	PRIVATE_TOOLS,
} from "./turn-policy.ts";

/**
 * The private consultation loop: the advisor's own agentic turn-taking, walled off
 * from the driver's.
 *
 * Nothing outside this module can reach the advisor, and the advisor cannot reach
 * anything outside it. That containment is the extension's central claim, and it
 * rests on three bounds enforced here rather than trusted: `maxAdvisorTurns` caps
 * how long it may run, `maxReadOnlyToolCalls` caps how much it may read, and
 * `timeoutMs` caps wall-clock time through an AbortSignal composed with the
 * caller's.
 *
 * Every decision is delegated — the turn shape to turn-policy.ts, the path filter
 * to path-access.ts, advice validation to contracts.ts, outbound bounding to
 * outbound-text.ts. What is left here is orchestration and effects, which is why
 * it keeps a clock parameter (S6) instead of reading one.
 *
 * A budget that runs out is not an error: the advisor is told, in the tool result,
 * that it must submit now. Telling it beats truncating it, because an advisor that
 * knows it is out of reads writes a conclusion rather than being cut off
 * mid-thought. The output budget gets the same treatment: a turn the provider
 * stopped with `stopReason: "length"` is retried once, told how long its advice may
 * be, and restricted to a lone submission. The truncated turn is *dropped* rather
 * than appended, because a turn cut off mid-tool-call leaves a `toolCall` part with
 * no matching `toolResult`, which OpenAI-shaped APIs reject on the next request. A
 * second length stop is `truncated`, which is the one failure whose remedy is a
 * configuration change (`maxAdvisorOutputTokens`) rather than a retry.
 */
const INVALID_SUBMISSION_NOTICE =
	"Advice was not accepted because one or more required fields were missing or invalid. Submit one complete advice object again. Do not call repository tools.";
const READ_BUDGET_NOTICE =
	"Read-only tool budget is exhausted. Submit advice now without another repository tool call.";
const TRUNCATION_NOTICE =
	"The previous turn was cut off by the output limit. Submit one complete submit_advice call now. Keep the summary under 400 characters, and use at most three rationale entries, three recommended actions, and three risks. Omit the optional evidence arrays.";

function addUsage(total: Usage | undefined, usage: Usage | undefined): Usage | undefined {
	if (!usage) return total;
	if (!total) return { ...usage, cost: { ...usage.cost } };
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0),
		reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0),
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: {
			input: total.cost.input + usage.cost.input,
			output: total.cost.output + usage.cost.output,
			cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
			total: total.cost.total + usage.cost.total,
		},
	};
}

function toolResult(id: string, name: string, text: string, now: () => number) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: name,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: now(),
	};
}

interface CompletionRegistry {
	complete(model: Model<Api>, context: Context, options?: unknown): Promise<AssistantMessage>;
}

/**
 * Which of the loop's six refusals produced an `invalid_response`. `invalid_response`
 * is one driver-facing sentence for six distinct events, and the journal recorded
 * only that sentence's key — enough to know a consultation failed, not enough to
 * know why (A7).
 *
 * A closed vocabulary, never model text, so recording it leaves the "raw provider
 * responses are not persisted" non-goal intact. The driver-facing sentence is
 * unchanged; this is only for `details` and `/advisor status`.
 */
export type AdvisorFailureDetail =
	| InvalidTurnReason
	| "options_unavailable"
	| "duplicate_submission"
	| "schema_rejected"
	| "unknown_tool"
	| "turn_budget";

/**
 * Execute one turn's repository calls in order, appending each result to the
 * conversation. Returns the new running count, or `invalid` for a call the turn
 * policy does not admit.
 *
 * Calls are executed as they are walked, so a valid read followed by an unknown
 * name leaves the read run and counted. That is pre-existing behaviour and is
 * deliberately preserved (§17); turn-policy.ts explains why it is not hoisted.
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
 * Deviates from F5's ~40 lines: what remains is six pieces of loop state
 * (usage, read count, the two retry counters and the two submission flags) that a
 * further split would have to thread through helpers and read back, which is more
 * error-prone than the sequence it replaces, not less.
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
}): Promise<{
	advice?: Advice;
	usage?: Usage;
	readOnlyToolCalls: number;
	failure?: "aborted" | "timeout" | "invalid_response" | "truncated" | "provider_error";
	/** Which refusal this was. Set for every `invalid_response`, and only for those. */
	detail?: AdvisorFailureDetail;
}> {
	const now = input.now ?? Date.now;
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), input.config.limits.timeoutMs);
	const signal = AbortSignal.any(input.signal ? [input.signal, timeout.signal] : [timeout.signal]);
	const options = advisorCompletionOptions(
		input.model,
		input.config.thinking,
		input.config.limits.maxAdvisorOutputTokens,
		signal,
	);
	if (!options) return { readOnlyToolCalls: 0, failure: "invalid_response", detail: "options_unavailable" };
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
	let truncations = 0;
	let correctionOnly = false;
	try {
		for (let turn = 0; turn < input.config.limits.maxAdvisorTurns; turn += 1) {
			signal.throwIfAborted();
			const response = await input.registry.complete(input.model, context, options);
			usage = addUsage(usage, response.usage);
			// Checked before classifyTurn, and before the response is appended: a
			// length-stopped turn is retryable, and the partial turn itself must not
			// enter the conversation. See the header.
			if (response.stopReason === "length") {
				truncations += 1;
				if (truncations > 1) return { usage, readOnlyToolCalls, failure: "truncated" };
				context.messages.push({ role: "user", content: TRUNCATION_NOTICE, timestamp: now() });
				correctionOnly = true;
				continue;
			}
			context.messages.push(response);
			const turnResult = classifyTurn(response.content, { correctionOnly });
			if (turnResult.kind === "invalid")
				return { usage, readOnlyToolCalls, failure: "invalid_response", detail: turnResult.reason };

			if (turnResult.kind === "submit") {
				const call = turnResult.call;
				if (submitted)
					return { usage, readOnlyToolCalls, failure: "invalid_response", detail: "duplicate_submission" };
				submitted = true;
				const advice = validateAdvice(call.arguments.advice);
				if (advice) return { advice, usage, readOnlyToolCalls };
				invalidSubmissions += 1;
				if (invalidSubmissions > 1)
					return { usage, readOnlyToolCalls, failure: "invalid_response", detail: "schema_rejected" };
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
			if (executed.invalid) return { usage, readOnlyToolCalls, failure: "invalid_response", detail: "unknown_tool" };
		}
		return { usage, readOnlyToolCalls, failure: "invalid_response", detail: "turn_budget" };
	} catch {
		if (signal.aborted) return { usage, readOnlyToolCalls, failure: timeout.signal.aborted ? "timeout" : "aborted" };
		return { usage, readOnlyToolCalls, failure: "provider_error" };
	} finally {
		clearTimeout(timer);
	}
}
