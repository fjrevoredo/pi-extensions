import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const ADVISOR_VERSION = 1;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_LIMITS = {
	maxConsultationsPerRun: 3,
	maxConsultationsPerSession: 12,
	maxAdvisorTurns: 6,
	maxReadOnlyToolCalls: 8,
	maxContextBytes: 96_000,
	maxAdvisorOutputTokens: 1_600,
	timeoutMs: 120_000,
} as const;

export type AdvisorLimits = { [Key in keyof typeof DEFAULT_LIMITS]: number };

export interface AdvisorConfig {
	version: typeof ADVISOR_VERSION;
	enabled: boolean;
	model?: string;
	thinking: ThinkingLevel;
	limits: AdvisorLimits;
	security: {
		redactKnownSecrets: boolean;
		additionalProtectedPaths: string[];
	};
}

export const AdviceSchema = Type.Object(
	{
		outcome: StringEnum(["on_track", "course_correct", "not_ready", "stop"] as const),
		summary: Type.String({ minLength: 1, maxLength: 1_200 }),
		rationale: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 8 }),
		recommendedActions: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), { maxItems: 5 }),
		risks: Type.Array(
			Type.Object(
				{
					severity: StringEnum(["low", "medium", "high", "critical"] as const),
					description: Type.String({ minLength: 1, maxLength: 800 }),
					evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 5 })),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 8 },
		),
		verification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 6 }),
		assumptions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 6 }),
		confidence: StringEnum(["low", "medium", "high"] as const),
	},
	{ additionalProperties: false },
);
export type Advice = Static<typeof AdviceSchema>;

export type AdvisorFailure =
	| "disabled"
	| "unconfigured"
	| "unavailable"
	| "unsupported_thinking"
	| "budget_exhausted"
	| "aborted"
	| "timeout"
	| "invalid_response"
	| "provider_error";

export interface AdvisorDetails {
	model?: string;
	durationMs: number;
	readOnlyToolCalls: number;
	usage?: Usage;
	advice?: Advice;
	failure?: AdvisorFailure;
}

export function defaultConfig(): AdvisorConfig {
	return {
		version: ADVISOR_VERSION,
		enabled: false,
		thinking: "high",
		limits: { ...DEFAULT_LIMITS },
		security: { redactKnownSecrets: true, additionalProtectedPaths: [] },
	};
}

function boundedStrings(value: unknown, minimum: number, maximum: number, maxLength: number): value is string[] {
	return Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxLength);
}

export function validateAdvice(value: unknown): Advice | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const advice = value as Record<string, unknown>;
	const expected = new Set(["outcome", "summary", "rationale", "recommendedActions", "risks", "verification", "assumptions", "confidence"]);
	if (Object.keys(advice).some((key) => !expected.has(key))) return undefined;
	if (!(["on_track", "course_correct", "not_ready", "stop"] as const).includes(advice.outcome as Advice["outcome"])) return undefined;
	if (typeof advice.summary !== "string" || !advice.summary.trim() || advice.summary.length > 1_200) return undefined;
	if (!boundedStrings(advice.rationale, 1, 8, 1_000) || !boundedStrings(advice.recommendedActions, 0, 5, 600)) return undefined;
	if (!boundedStrings(advice.verification, 0, 6, 500) || !boundedStrings(advice.assumptions, 0, 6, 500)) return undefined;
	if (!(["low", "medium", "high"] as const).includes(advice.confidence as Advice["confidence"]) || !Array.isArray(advice.risks) || advice.risks.length > 8) return undefined;
	for (const risk of advice.risks) {
		if (!risk || typeof risk !== "object" || Array.isArray(risk)) return undefined;
		const item = risk as Record<string, unknown>;
		if (Object.keys(item).some((key) => key !== "severity" && key !== "description" && key !== "evidence")) return undefined;
		if (!(["low", "medium", "high", "critical"] as const).includes(item.severity as "low" | "medium" | "high" | "critical")) return undefined;
		if (typeof item.description !== "string" || !item.description.trim() || item.description.length > 800) return undefined;
		if (item.evidence !== undefined && !boundedStrings(item.evidence, 0, 5, 300)) return undefined;
	}
	const typed = advice as unknown as Advice;
	if (typed.outcome === "on_track" && typed.risks.length > 0) return undefined;
	if ((typed.outcome === "not_ready" || typed.outcome === "stop") && typed.recommendedActions.length === 0) return undefined;
	return typed;
}

export function formatAdvice(advice: Advice): string {
	const lines = [`Advisor outcome: ${advice.outcome}`, `Summary: ${advice.summary}`];
	if (advice.recommendedActions.length) {
		lines.push("Recommended actions:", ...advice.recommendedActions.map((action, index) => `${index + 1}. ${action}`));
	}
	if (advice.verification.length) lines.push(`Verification: ${advice.verification.join("; ")}`);
	return lines.join("\n");
}
