import { formatConfig } from "./config.ts";
import type { AdvisorConfig, AdvisorFailure } from "./contracts.ts";
import { modelName, type ModelReference } from "./model-reference.ts";

/**
 * The pure core of the `/advisor` command: what an argument means, and every
 * sentence the command puts in front of the user.
 *
 * Named for the slash command, not for the advisor's own tools — "commands the
 * advisor may run" is `turn-policy.ts`, and the two must not be confused.
 *
 * These strings are the extension's contract with the user, so they live in one
 * module where they can be read together and asserted verbatim. Pure: the
 * entrypoint owns every `ctx.ui` call, this module only decides what goes in one.
 */

/** Shown when the configuration file exists but reading it produced no message. */
export const CONFIG_UNAVAILABLE_MESSAGE = "Advisor configuration is unavailable.";
export const USAGE_MESSAGE = "Use /advisor, /advisor on, /advisor off, /advisor status, or /advisor config.";
export const NO_UI_MESSAGE = "/advisor requires an interactive UI. Use /advisor config for current configuration.";
export const NO_MODELS_MESSAGE = "No authenticated advisor model is available.";

/**
 * The model prompt states the data flow in the prompt itself. The disclosure
 * below repeats it because the two are separated by a second selection, and P2
 * wants the consequence visible at the moment of consent, not only before it.
 */
export const MODEL_SELECT_PROMPT =
	"Select the advisor model. Driver context and permitted repository data will be sent to its provider.";
export const THINKING_SELECT_PROMPT = "Select advisor thinking level.";

export const SAME_MODEL_WARNING =
	"The advisor uses the active driver model. A distinct stronger model can give more independent advice.";
export const WEAKER_MODEL_WARNING =
	"The selected advisor has lower known context or output capacity than the active driver model.";

export const DISCLOSURE_TITLE = "Advisor provider disclosure";

/** What `/advisor` was asked to do. An empty argument means "configure me". */
export type AdvisorCommand =
	| { kind: "toggle"; enabled: boolean }
	| { kind: "status" }
	| { kind: "configure" }
	| { kind: "unknown" };

/**
 * Arguments are trimmed and lowercased first, so `"  On  "` toggles on. Anything
 * non-empty that is not recognised is `unknown` rather than falling through to
 * the interactive wizard — a typo must not open a prompt that writes config.
 */
export function parseAdvisorCommand(rawArgs: string): AdvisorCommand {
	const args = rawArgs.trim().toLowerCase();
	if (args === "on" || args === "off") return { kind: "toggle", enabled: args === "on" };
	if (args === "status" || args === "config") return { kind: "status" };
	return args ? { kind: "unknown" } : { kind: "configure" };
}

export function toggleMessage(enabled: boolean): string {
	return `Advisor is ${enabled ? "enabled" : "disabled"} for this session.`;
}

export function savedMessage(model: string, thinking: string): string {
	return `Advisor saved: ${model} (${thinking}).`;
}

/**
 * The disclosure names the provider because that is the part the user cannot
 * infer, and it says plainly what the filtering is not. The same sentence is in
 * the README; changing one without the other is the drift P1 warns about.
 */
export function providerDisclosure(provider: string): string {
	return `The advisor receives selected task context and permitted repository text through ${provider}. Path filtering and redaction reduce risk but are not a security sandbox. Continue?`;
}

export interface AdvisorStatus {
	config: AdvisorConfig;
	/** The session override, or `undefined` when the file's value is in force. */
	sessionEnabled?: boolean;
	run: number;
	attempted: number;
	lastError?: AdvisorFailure;
}

/**
 * The `/advisor status` block. Reports the session override and the on-disk value
 * separately: they disagree whenever `/advisor on|off` has been used, and which
 * one is winning is the question this block exists to answer.
 */
export function formatAdvisorStatus(status: AdvisorStatus): string {
	const { config } = status;
	const budget =
		`consultations: ${status.run}/${config.limits.maxConsultationsPerRun} run, ` +
		`${status.attempted}/${config.limits.maxConsultationsPerSession} session`;
	const lastError = status.lastError ? `\nlast error: ${status.lastError}` : "";
	return `${formatConfig(config)}\nsession enabled: ${status.sessionEnabled ?? config.enabled}\n${budget}${lastError}`;
}

/** The part of a model a capability comparison reads. `Model<Api>` satisfies it. */
export interface ModelCapability extends ModelReference {
	contextWindow: number;
	maxTokens: number;
}

/**
 * Advice on the selected advisor, or `undefined` when there is nothing to say.
 *
 * Both cases are warnings, not refusals — the user may have a reason, and a
 * weaker advisor still answers. With no active driver model there is nothing to
 * compare against, so neither warning applies.
 *
 * "Known" capacity is the point of the second message: `contextWindow` and
 * `maxTokens` come from pi's model metadata, so a model missing or understating
 * them can be reported as weaker when it is not.
 */
export function capabilityWarning(advisor: ModelCapability, driver?: ModelCapability): string | undefined {
	if (!driver) return undefined;
	if (modelName(driver) === modelName(advisor)) return SAME_MODEL_WARNING;
	if (advisor.contextWindow < driver.contextWindow || advisor.maxTokens < driver.maxTokens) {
		return WEAKER_MODEL_WARNING;
	}
	return undefined;
}
