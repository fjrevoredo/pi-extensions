import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./contracts.ts";

const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const GOOGLE_LEVELS = new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);

type ToolChoice = "required" | "any";

export function isSupportedThinking(model: Model<Api>, level: ThinkingLevel): boolean {
	return getSupportedThinkingLevels(model).includes(level);
}

function requiredToolChoice(api: Api): ToolChoice | undefined {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
		case "mistral-conversations":
			return "required";
		case "anthropic-messages":
		case "bedrock-converse-stream":
		case "google-generative-ai":
		case "google-vertex":
			return "any";
		default:
			return undefined;
	}
}

function anthropicEffort(model: Model<Api>, level: Exclude<ThinkingLevel, "off">): "low" | "medium" | "high" | "xhigh" | "max" {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string" && ANTHROPIC_EFFORTS.has(mapped)) return mapped as "low" | "medium" | "high" | "xhigh" | "max";
	if (level === "minimal" || level === "low") return "low";
	if (level === "medium") return "medium";
	if (level === "high") return "high";
	return "high";
}

function googleThinkingLevel(model: Model<Api>, level: Exclude<ThinkingLevel, "off">): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string" && GOOGLE_LEVELS.has(mapped)) return mapped as "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
	if (level === "minimal") return "MINIMAL";
	if (level === "low") return "LOW";
	if (level === "medium") return "MEDIUM";
	return "HIGH";
}

/**
 * ModelRegistry.complete() does not accept Pi's provider-neutral `reasoning`
 * option. This adapter sends only documented, API-specific options. It rejects
 * an unavailable level instead of silently dropping it.
 */
export function advisorCompletionOptions(model: Model<Api>, level: ThinkingLevel, maxTokens: number, signal: AbortSignal) {
	if (!isSupportedThinking(model, level)) return undefined;
	const toolChoice = requiredToolChoice(model.api);
	if (!toolChoice) return undefined;
	const base = { maxTokens, signal, toolChoice };
	if (level === "off") return base;
	switch (model.api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
		case "mistral-conversations":
			return { ...base, reasoningEffort: level };
		case "anthropic-messages":
			return { ...base, thinkingEnabled: true, effort: anthropicEffort(model, level) };
		case "bedrock-converse-stream":
			return { ...base, reasoning: level };
		case "google-generative-ai":
		case "google-vertex":
			return { ...base, thinking: { enabled: true, level: googleThinkingLevel(model, level) } };
		default:
			return undefined;
	}
}
