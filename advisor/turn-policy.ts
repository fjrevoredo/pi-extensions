import { Type } from "typebox";
import { AdviceSchema } from "./contracts.ts";

/**
 * What one advisor turn may legally do.
 *
 * This is the advisor-facing counterpart to permission-gate's rule catalogue,
 * and P3 applies to it the same way: the checks below are ordered, the order is
 * behaviour, and the catalogue lives in one module.
 *
 * The advisor is not the driver. It reaches only these five tools, four of which
 * are read-only and one of which ends the consultation. Nothing here can edit a
 * file, run a command, or contact the user — that is the whole point of the
 * private loop, and widening this list widens the extension's blast radius.
 */
export const PRIVATE_TOOLS = [
	{
		name: "read",
		description: "Read one permitted text file. Output is capped and redacted.",
		parameters: Type.Object({ path: Type.String() }),
	},
	{
		name: "grep",
		description: "Search permitted repository text files with a regular expression.",
		parameters: Type.Object({
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
		}),
	},
	{
		name: "find",
		description: "List permitted repository paths under a directory.",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
		}),
	},
	{
		name: "ls",
		description: "List one permitted repository directory.",
		parameters: Type.Object({ path: Type.Optional(Type.String()) }),
	},
	{
		name: "submit_advice",
		description:
			"Submit exactly one final advice object. Required fields: outcome (on_track, course_correct, not_ready, stop), non-empty summary, non-empty rationale, recommendedActions, risks with severity and description, verification, assumptions, and confidence. Use an empty risks array only for on_track with no concrete risk. This ends the consultation.",
		parameters: Type.Object({ advice: AdviceSchema }, { additionalProperties: false }),
	},
] as const;

export const PRIVATE_TOOL_NAMES = PRIVATE_TOOLS.map((tool) => tool.name);

export const SUBMIT_ADVICE = "submit_advice";

/** The four read-only tools. Deliberately not derived from PRIVATE_TOOLS: this list is the guard. */
export const REPOSITORY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type RepositoryToolName = (typeof REPOSITORY_TOOL_NAMES)[number];

export interface AdvisorToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export function isPrivateTool(name: string): boolean {
	return PRIVATE_TOOL_NAMES.includes(name as (typeof PRIVATE_TOOL_NAMES)[number]);
}

export function isRepositoryTool(name: string): name is RepositoryToolName {
	return REPOSITORY_TOOL_NAMES.includes(name as RepositoryToolName);
}

export function toolCallsIn(content: readonly unknown[]): AdvisorToolCall[] {
	return content.filter((part: unknown): part is AdvisorToolCall =>
		Boolean(part && typeof part === "object" && (part as { type?: string }).type === "toolCall"),
	);
}

export type TurnClassification =
	| { kind: "invalid" }
	| { kind: "submit"; call: AdvisorToolCall }
	/**
	 * A non-submission turn. Each call still has to be admitted individually by
	 * the loop — see the ordering note below.
	 */
	| { kind: "calls"; calls: AdvisorToolCall[] };

/**
 * Classify one assistant turn. Order is behaviour (P3):
 *
 * 1. a turn with no tool call at all is invalid — the advisor is required to act
 * 2. a submission must be the *only* call in its turn, and there may be only one
 * 3. after a rejected submission the advisor is allowed exactly one thing:
 *    resubmit. Anything else, including a repository read, ends the consultation
 *
 * What this deliberately does NOT do is reject a turn containing an unknown tool
 * name. That check stays in the loop, per call, because the loop executes calls
 * as it walks them: given `[read, bash]` the read runs and is counted before the
 * bash is refused. Hoisting the check here would be tidier and would silently
 * change both the recorded tool count and what the advisor is told (§19).
 */
export function classifyTurn(content: readonly unknown[], options: { correctionOnly: boolean }): TurnClassification {
	const calls = toolCallsIn(content);
	if (calls.length === 0) return { kind: "invalid" };

	const submissions = calls.filter((call) => call.name === SUBMIT_ADVICE);
	if (submissions.length > 1 || (submissions.length === 1 && calls.length !== 1)) return { kind: "invalid" };

	if (options.correctionOnly && (calls.length !== 1 || calls[0]?.name !== SUBMIT_ADVICE)) return { kind: "invalid" };

	const only = calls[0];
	if (submissions.length === 1 && only) return { kind: "submit", call: only };
	return { kind: "calls", calls };
}
