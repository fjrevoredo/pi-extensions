import type { AdvisorConfig, AdvisorFailure } from "./contracts.ts";
import { parseModel } from "./model-reference.ts";

/**
 * The pure core of `consult_advisor`: what stops a consultation before it starts,
 * and what the driver is told when one is stopped.
 *
 * Every failure here is fail-open in the sense the README means: the driver gets
 * a short sentence and keeps working. It is *not* fail-open about data — no
 * repository text and no session context leaves the machine on any path below,
 * because none of them reach the provider at all.
 *
 * The gates are ordered and **the order is behaviour** (P3), in the same sense
 * permission-gate's rule order is. The full precedence chain is:
 *
 * | # | Condition                              | Failure                |
 * |---|----------------------------------------|------------------------|
 * | 1 | the call is already cancelled           | `aborted`              |
 * | 2 | configuration missing or unreadable     | `unconfigured`         |
 * | 3 | disabled for this session or on disk    | `disabled`             |
 * | 4 | no model configured                     | `unconfigured`         |
 * | 5 | run or session budget spent             | `budget_exhausted`     |
 * | 6 | model not found or not authenticated    | `unavailable`          |
 * | 7 | thinking level unsupported              | `unsupported_thinking` |
 *
 * Rows 3 and 4 are both `unconfigured`-adjacent and are *not* interchangeable: a
 * disabled advisor that also has no model must report `disabled`, because that is
 * the state the user chose and the one they can act on.
 *
 * Row 1 is enforced by the caller rather than here, and that placement is
 * deliberate: it reads a live `AbortSignal`, and checking it first means an
 * already-cancelled call does no filesystem I/O at all. `decideConsultation`
 * covers rows 2–5; `checkAdvisorModel` covers rows 6–7.
 *
 * The table is the *pre-flight* chain only. `aborted`, `timeout`,
 * `invalid_response`, `truncated` and `provider_error` are loop-level outcomes
 * reported by `advisor-loop.ts` after a provider has been contacted, so they have
 * no row and no precedence relative to the gates above; they only need a message.
 */
export const FAILURE_MESSAGES: Record<AdvisorFailure, string> = {
	disabled: "Advisor is disabled. Continue with local evidence.",
	unconfigured: "Advisor is not configured. Continue with local evidence.",
	unavailable: "Advisor model is unavailable. Continue with local evidence.",
	unsupported_thinking: "Advisor thinking level is unsupported. Continue with local evidence.",
	budget_exhausted: "Advisor consultation budget is exhausted. Continue with local evidence.",
	// `aborted` and `timeout` share a message on purpose: from the driver's side
	// they are the same event, and distinguishing them would only invite the
	// driver to retry the one that will time out again. `details.failure` keeps
	// them apart for anyone reading the transcript.
	aborted: "Advisor consultation did not complete. Continue with local evidence.",
	timeout: "Advisor consultation did not complete. Continue with local evidence.",
	invalid_response: "Advisor did not return validated advice. Continue with local evidence.",
	// Its own sentence rather than sharing `invalid_response`'s, because the user
	// action differs: raise `maxAdvisorOutputTokens`.
	truncated: "Advisor response exceeded its output budget. Continue with local evidence.",
	provider_error: "Advisor consultation failed. Continue with local evidence.",
};

/** A configuration that cleared every gate, so its model reference is present. */
export type ConfiguredAdvisor = AdvisorConfig & { model: string };

export interface ConsultationRequest {
	/** The result of reading the configuration file, error included. */
	loaded: { config?: AdvisorConfig; error?: string };
	/** `/advisor on|off` for this session, or `undefined` to defer to the file. */
	sessionEnabled?: boolean;
	/** Consultations already started in this agent run and in this session. */
	run: number;
	attempted: number;
}

/**
 * Rows 2–5 of the precedence table. Takes already-fetched values rather than a
 * `ctx` so that the whole chain is testable without pi.
 */
export function decideConsultation(
	request: ConsultationRequest,
): { failure: AdvisorFailure } | { config: ConfiguredAdvisor } {
	const config = request.loaded.config;
	if (request.loaded.error || !config) return { failure: "unconfigured" };
	if (!(request.sessionEnabled ?? config.enabled)) return { failure: "disabled" };
	if (!config.model) return { failure: "unconfigured" };
	const spentRun = request.run >= config.limits.maxConsultationsPerRun;
	const spentSession = request.attempted >= config.limits.maxConsultationsPerSession;
	if (spentRun || spentSession) return { failure: "budget_exhausted" };
	return { config: config as ConfiguredAdvisor };
}

/**
 * What resolving a configured model reference needs from pi's registry, injected
 * so this module keeps S2. `TModel` is whatever the registry hands back; nothing
 * here inspects it.
 */
export interface AdvisorModelLookup<TModel> {
	/** Resolve a parsed `provider`/`id` pair, or `undefined` if unknown. */
	find(provider: string, id: string): TModel | undefined;
	/** Every model the user is currently authenticated for, as `provider/id`. */
	availableNames(): string[];
	supportsThinking(model: TModel): boolean;
	/** Whether provider-specific completion options can be built for this model. */
	canBuildCompletionOptions(model: TModel): boolean;
}

/**
 * Rows 6–7. A reference that parses but names an unknown or unauthenticated model
 * is `unavailable`; one that resolves but cannot carry the configured thinking
 * level is `unsupported_thinking`.
 *
 * The `&&`/`||` short-circuiting is load-bearing, not just terse: `availableNames`
 * is never asked for when the reference did not resolve, and
 * `canBuildCompletionOptions` — which allocates on the caller's side — is never
 * called for a model that already failed the thinking check.
 */
export function checkAdvisorModel<TModel>(
	reference: string,
	lookup: AdvisorModelLookup<TModel>,
): { failure: AdvisorFailure } | { model: TModel } {
	const parsed = parseModel(reference);
	const model = parsed && lookup.find(...parsed);
	if (!model || !lookup.availableNames().includes(reference)) return { failure: "unavailable" };
	if (!lookup.supportsThinking(model) || !lookup.canBuildCompletionOptions(model)) {
		return { failure: "unsupported_thinking" };
	}
	return { model };
}
