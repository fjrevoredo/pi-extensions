/**
 * Advisor Extension
 *
 * Global pi extension entrypoint for consulting a second, read-only model.
 *
 * This file is wiring (L3): lifecycle subscriptions, the command and tool
 * registrations, and the `ctx.ui` / `pi.exec` / `pi.appendEntry` calls. Every
 * decision it appears to make is delegated —
 *
 * - `consultation.ts`  what stops a consultation, and what the driver is told
 * - `slash-command.ts` what a `/advisor` argument means, and every user-facing string
 * - `model-reference.ts` the `provider/id` format
 * - `context.ts` / `evidence.ts` what the advisor is shown
 * - `advisor-loop.ts`  the private read-only loop
 * - `path-policy.ts` / `path-access.ts` which files that loop may open
 *
 * `resolveRoot` and `gitSnapshot` stay here rather than moving to a core module:
 * both are a `pi.exec` call and nothing else, and a `pi.exec` call *is* what the
 * extension does to pi. `context-footer/index.ts` sets the same precedent.
 *
 * Scope boundary: failures always return control to the driver. That is fail-open
 * about *control*, not about data — no repository text or session context reaches
 * a provider on any failure path.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { advisorCompletionOptions, isSupportedThinking } from "./advisor-options.ts";
import { advisorConfigPath, loadConfig, saveConfig } from "./config.ts";
import { checkAdvisorModel, decideConsultation, FAILURE_MESSAGES } from "./consultation.ts";
import { formatAdvice, type AdvisorConfig, type AdvisorDetails, type AdvisorFailure } from "./contracts.ts";
import { buildAdvisorContext } from "./context.ts";
import { modelName } from "./model-reference.ts";
import { runAdvisorLoop } from "./advisor-loop.ts";
import {
	capabilityWarning,
	CONFIG_UNAVAILABLE_MESSAGE,
	DISCLOSURE_TITLE,
	formatAdvisorStatus,
	MODEL_SELECT_PROMPT,
	NO_MODELS_MESSAGE,
	NO_UI_MESSAGE,
	parseAdvisorCommand,
	providerDisclosure,
	savedMessage,
	THINKING_SELECT_PROMPT,
	toggleMessage,
	USAGE_MESSAGE,
} from "./slash-command.ts";

const ENTRY_TYPE = "advisor-consultation-v1";

interface SessionState {
	attempted: number;
	run: number;
	enabled?: boolean;
	lastError?: AdvisorFailure;
}

/**
 * What the entrypoint needs from pi's process environment, injected so the tests
 * can point the extension at a directory that is not the user's real `~/.pi`
 * (T7). `ExtensionFactory` is `(pi: ExtensionAPI) => void | Promise<void>` and
 * pi's loader calls `factory(api)` with exactly one argument, so in production
 * this default is always the one in force.
 */
interface AdvisorDeps {
	/** The *function*, not its result: handlers must resolve it per call (E1). */
	agentDirectory: () => string;
}

function fail(failure: AdvisorFailure, state: SessionState, durationMs = 0): { text: string; details: AdvisorDetails } {
	state.lastError = failure;
	return { text: FAILURE_MESSAGES[failure], details: { durationMs, readOnlyToolCalls: 0, failure } };
}

async function resolveRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 5_000 });
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
	} catch {
		return cwd;
	}
}

async function gitSnapshot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	const run = async (args: string) => {
		try {
			const result = await pi.exec("git", args.split(" "), { cwd, signal, timeout: 5_000 });
			return result.code === 0 ? result.stdout : "";
		} catch {
			return "";
		}
	};
	return `status:\n${await run("status --porcelain")}\ndiff stat:\n${await run("diff --stat")}`;
}

export default function advisor(pi: ExtensionAPI, deps: AdvisorDeps = { agentDirectory: getAgentDir }) {
	const state: SessionState = { attempted: 0, run: 0 };
	const restore = (ctx: ExtensionContext) => {
		state.attempted = 0;
		state.run = 0;
		state.enabled = undefined;
		state.lastError = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			if (!entry.data || typeof entry.data !== "object") continue;
			const data = entry.data as Partial<SessionState>;
			if (typeof data.attempted === "number") state.attempted = data.attempted;
			if (typeof data.enabled === "boolean") state.enabled = data.enabled;
			if (typeof data.lastError === "string") state.lastError = data.lastError as AdvisorFailure;
		}
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => {
		state.enabled = undefined;
		state.run = 0;
	});
	pi.on("before_agent_start", async () => {
		state.run = 0;
	});

	pi.registerCommand("advisor", {
		description: "Configure, enable, disable, or inspect the read-only advisor.",
		handler: async (rawArgs, ctx) => {
			const command = parseAdvisorCommand(rawArgs);
			// Resolved per invocation, not at factory scope: the factory also runs in
			// invocations that never open a session (E1).
			const configPath = advisorConfigPath(deps.agentDirectory());
			const loaded = await loadConfig(configPath);
			if (loaded.error || !loaded.config) {
				ctx.ui.notify(loaded.error ?? CONFIG_UNAVAILABLE_MESSAGE, "error");
				return;
			}
			const config = loaded.config;
			if (command.kind === "toggle") {
				state.enabled = command.enabled;
				pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled });
				ctx.ui.notify(toggleMessage(command.enabled), "info");
				return;
			}
			if (command.kind === "status") {
				const status = formatAdvisorStatus({
					config,
					sessionEnabled: state.enabled,
					run: state.run,
					attempted: state.attempted,
					lastError: state.lastError,
				});
				if (ctx.hasUI) ctx.ui.notify(status, "info");
				else console.log(status);
				return;
			}
			if (command.kind === "unknown") {
				ctx.ui.notify(USAGE_MESSAGE, "warning");
				return;
			}
			// Configuring writes the provider the advisor will talk to, so it is
			// refused without a UI rather than defaulted: the disclosure below is
			// mandatory, and there is no way to obtain consent from a pipe (P2).
			if (!ctx.hasUI) {
				console.log(NO_UI_MESSAGE);
				return;
			}
			const available = ctx.modelRegistry.getAvailable();
			if (!available.length) {
				ctx.ui.notify(NO_MODELS_MESSAGE, "error");
				return;
			}
			const selected = await ctx.ui.select(MODEL_SELECT_PROMPT, available.map(modelName));
			if (!selected) return;
			const model = available.find((candidate) => modelName(candidate) === selected);
			if (!model) return;
			const warning = capabilityWarning(model, ctx.model);
			if (warning) ctx.ui.notify(warning, "warning");
			const thinking = await ctx.ui.select(THINKING_SELECT_PROMPT, getSupportedThinkingLevels(model));
			if (!thinking) return;
			const okay = await ctx.ui.confirm(DISCLOSURE_TITLE, providerDisclosure(model.provider));
			if (!okay) return;
			const next: AdvisorConfig = {
				...config,
				enabled: true,
				model: selected,
				thinking: thinking as AdvisorConfig["thinking"],
			};
			await saveConfig(next, configPath);
			ctx.ui.notify(savedMessage(selected, thinking), "info");
		},
	});

	// The driver can only trigger this parameterless, sequential consultation. The
	// private loop is read-only and failures always return control to the driver.
	pi.registerTool({
		name: "consult_advisor",
		label: "Consult Advisor",
		description:
			"Get bounded read-only technical advice from the configured advisor model. The advisor cannot edit files, run commands, or contact the user.",
		promptSnippet: "Consult a configured read-only advisor for high-leverage technical guidance.",
		promptGuidelines: [
			"Use consult_advisor only after relevant repository orientation and before a consequential design, refactor, high-risk change, repeated materially similar failure, or non-trivial completion claim.",
			"Do not use consult_advisor for simple facts, mechanical one-file work, before relevant repository reads, after every tool call, or when no new evidence exists.",
			"Treat consult_advisor output as guidance. Verify its claims with your own tools and make all edits yourself.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const parentSignal = signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : (signal ?? ctx.signal);
			const started = Date.now();
			const failureResult = (failure: AdvisorFailure, readOnlyToolCalls = 0, usage?: Usage) => {
				const safe = fail(failure, state, Date.now() - started);
				pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled, lastError: failure });
				return {
					content: [{ type: "text" as const, text: safe.text }],
					details: { ...safe.details, readOnlyToolCalls, usage },
					usage,
				};
			};
			// Row 1 of consultation.ts's precedence table, checked here and before the
			// configuration read so an already-cancelled call does no I/O at all.
			if (parentSignal?.aborted) return failureResult("aborted");
			const agentDirectory = deps.agentDirectory();
			const decision = decideConsultation({
				loaded: await loadConfig(advisorConfigPath(agentDirectory)),
				sessionEnabled: state.enabled,
				run: state.run,
				attempted: state.attempted,
			});
			if ("failure" in decision) return failureResult(decision.failure);
			const config = decision.config;
			const checked = checkAdvisorModel<Model<Api>>(config.model, {
				find: (provider, id) => ctx.modelRegistry.find(provider, id),
				availableNames: () => ctx.modelRegistry.getAvailable().map(modelName),
				supportsThinking: (candidate) => isSupportedThinking(candidate, config.thinking),
				canBuildCompletionOptions: (candidate) =>
					Boolean(
						advisorCompletionOptions(
							candidate,
							config.thinking,
							config.limits.maxAdvisorOutputTokens,
							parentSignal ?? new AbortController().signal,
						),
					),
			});
			if ("failure" in checked) return failureResult(checked.failure);
			state.run += 1;
			state.attempted += 1;
			pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled });
			try {
				const root = await resolveRoot(pi, ctx.cwd, parentSignal);
				const evidence = await buildAdvisorContext(
					ctx,
					config.limits.maxContextBytes,
					() => gitSnapshot(pi, ctx.cwd, parentSignal),
					config.security.redactKnownSecrets,
				);
				const result = await runAdvisorLoop({
					registry: ctx.modelRegistry,
					model: checked.model,
					config,
					root,
					agentDirectory,
					...evidence,
					signal: parentSignal,
				});
				if (!result.advice) {
					return failureResult(result.failure ?? "invalid_response", result.readOnlyToolCalls, result.usage);
				}
				state.lastError = undefined;
				const details: AdvisorDetails = {
					model: config.model,
					durationMs: Date.now() - started,
					readOnlyToolCalls: result.readOnlyToolCalls,
					usage: result.usage,
					advice: result.advice,
				};
				pi.appendEntry(ENTRY_TYPE, {
					attempted: state.attempted,
					enabled: state.enabled,
					outcome: result.advice.outcome,
				});
				return {
					content: [{ type: "text" as const, text: formatAdvice(result.advice) }],
					details,
					usage: result.usage,
				};
			} catch {
				return failureResult(parentSignal?.aborted ? "aborted" : "provider_error");
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("consult_advisor")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AdvisorDetails;
			const text = details?.advice
				? theme.fg("success", `${details.advice.outcome}: ${details.advice.summary}`)
				: theme.fg("warning", details?.failure ?? "Advisor unavailable");
			return new Text(text, 0, 0);
		},
	});
}
