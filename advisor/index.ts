import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { advisorCompletionOptions, isSupportedThinking } from "./advisor-options.ts";
import { loadConfig, saveConfig, formatConfig } from "./config.ts";
import { defaultConfig, formatAdvice, type AdvisorConfig, type AdvisorDetails, type AdvisorFailure } from "./contracts.ts";
import { buildAdvisorContext } from "./context.ts";
import { runAdvisorLoop } from "./advisor-loop.ts";

const ENTRY_TYPE = "advisor-consultation-v1";
interface SessionState { attempted: number; run: number; enabled?: boolean; lastError?: AdvisorFailure; }

function modelName(model: Model<Api>): string { return `${model.provider}/${model.id}`; }
function parseModel(value: string): [string, string] | undefined {
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1 ? [value.slice(0, slash), value.slice(slash + 1)] : undefined;
}
function fail(failure: AdvisorFailure, state: SessionState, durationMs = 0): { text: string; details: AdvisorDetails } {
	state.lastError = failure;
	const text: Record<AdvisorFailure, string> = {
		disabled: "Advisor is disabled. Continue with local evidence.", unconfigured: "Advisor is not configured. Continue with local evidence.", unavailable: "Advisor model is unavailable. Continue with local evidence.", unsupported_thinking: "Advisor thinking level is unsupported. Continue with local evidence.", budget_exhausted: "Advisor consultation budget is exhausted. Continue with local evidence.", aborted: "Advisor consultation did not complete. Continue with local evidence.", timeout: "Advisor consultation did not complete. Continue with local evidence.", invalid_response: "Advisor did not return validated advice. Continue with local evidence.", provider_error: "Advisor consultation failed. Continue with local evidence.",
	};
	return { text: text[failure], details: { durationMs, readOnlyToolCalls: 0, failure } };
}

async function resolveRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 5_000 });
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
	} catch { return cwd; }
}

async function gitSnapshot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	const run = async (args: string) => {
		try {
			const result = await pi.exec("git", args.split(" "), { cwd, signal, timeout: 5_000 });
			return result.code === 0 ? result.stdout : "";
		} catch { return ""; }
	};
	return `status:\n${await run("status --porcelain")}\ndiff stat:\n${await run("diff --stat")}`;
}

export default function advisor(pi: ExtensionAPI) {
	const state: SessionState = { attempted: 0, run: 0 };
	const restore = (ctx: ExtensionContext) => {
		state.attempted = 0; state.run = 0; state.enabled = undefined; state.lastError = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
			const data = entry.data as Partial<SessionState>;
			if (typeof data.attempted === "number") state.attempted = data.attempted;
			if (typeof data.enabled === "boolean") state.enabled = data.enabled;
			if (typeof data.lastError === "string") state.lastError = data.lastError as AdvisorFailure;
		}
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => { state.enabled = undefined; state.run = 0; });
	pi.on("before_agent_start", async () => { state.run = 0; });

	pi.registerCommand("advisor", {
		description: "Configure, enable, disable, or inspect the read-only advisor.",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim().toLowerCase();
			const loaded = await loadConfig();
			if (loaded.error || !loaded.config) { ctx.ui.notify(loaded.error ?? "Advisor configuration is unavailable.", "error"); return; }
			const config = loaded.config;
			if (args === "on" || args === "off") {
				state.enabled = args === "on"; pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled });
				ctx.ui.notify(`Advisor is ${state.enabled ? "enabled" : "disabled"} for this session.`, "info"); return;
			}
			if (args === "status" || args === "config") {
				const status = `${formatConfig(config)}\nsession enabled: ${state.enabled ?? config.enabled}\nconsultations: ${state.run}/${config.limits.maxConsultationsPerRun} run, ${state.attempted}/${config.limits.maxConsultationsPerSession} session${state.lastError ? `\nlast error: ${state.lastError}` : ""}`;
				if (ctx.hasUI) ctx.ui.notify(status, "info"); else console.log(status); return;
			}
			if (args) { ctx.ui.notify("Use /advisor, /advisor on, /advisor off, /advisor status, or /advisor config.", "warning"); return; }
			if (!ctx.hasUI) { console.log("/advisor requires an interactive UI. Use /advisor config for current configuration."); return; }
			const available = ctx.modelRegistry.getAvailable();
			if (!available.length) { ctx.ui.notify("No authenticated advisor model is available.", "error"); return; }
			const selected = await ctx.ui.select("Select the advisor model. Driver context and permitted repository data will be sent to its provider.", available.map(modelName));
			if (!selected) return;
			const model = available.find((candidate) => modelName(candidate) === selected);
			if (!model) return;
			if (ctx.model && modelName(ctx.model) === selected) {
				ctx.ui.notify("The advisor uses the active driver model. A distinct stronger model can give more independent advice.", "warning");
			} else if (ctx.model && (model.contextWindow < ctx.model.contextWindow || model.maxTokens < ctx.model.maxTokens)) {
				ctx.ui.notify("The selected advisor has lower known context or output capacity than the active driver model.", "warning");
			}
			const levels = getSupportedThinkingLevels(model);
			const thinking = await ctx.ui.select("Select advisor thinking level.", levels);
			if (!thinking) return;
			const okay = await ctx.ui.confirm("Advisor provider disclosure", `The advisor receives selected task context and permitted repository text through ${model.provider}. Path filtering and redaction reduce risk but are not a security sandbox. Continue?`);
			if (!okay) return;
			const next: AdvisorConfig = { ...config, enabled: true, model: selected, thinking: thinking as AdvisorConfig["thinking"] };
			await saveConfig(next);
			ctx.ui.notify(`Advisor saved: ${selected} (${thinking}).`, "info");
		},
	});

	// The driver can only trigger this parameterless, sequential consultation. The
	// private loop is read-only and failures always return control to the driver.
	pi.registerTool({
		name: "consult_advisor", label: "Consult Advisor",
		description: "Get bounded read-only technical advice from the configured advisor model. The advisor cannot edit files, run commands, or contact the user.",
		promptSnippet: "Consult a configured read-only advisor for high-leverage technical guidance.",
		promptGuidelines: [
			"Use consult_advisor only after relevant repository orientation and before a consequential design, refactor, high-risk change, repeated materially similar failure, or non-trivial completion claim.",
			"Do not use consult_advisor for simple facts, mechanical one-file work, before relevant repository reads, after every tool call, or when no new evidence exists.",
			"Treat consult_advisor output as guidance. Verify its claims with your own tools and make all edits yourself.",
		],
		parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const parentSignal = signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal;
			const started = Date.now();
			const failureResult = (failure: AdvisorFailure, readOnlyToolCalls = 0, usage?: Usage) => {
				const safe = fail(failure, state, Date.now() - started);
				pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled, lastError: failure });
				return { content: [{ type: "text" as const, text: safe.text }], details: { ...safe.details, readOnlyToolCalls, usage }, usage };
			};
			if (parentSignal?.aborted) return failureResult("aborted");
			const loaded = await loadConfig();
			if (loaded.error || !loaded.config) return failureResult("unconfigured");
			const config = loaded.config;
			if (!(state.enabled ?? config.enabled)) return failureResult("disabled");
			if (!config.model) return failureResult("unconfigured");
			if (state.run >= config.limits.maxConsultationsPerRun || state.attempted >= config.limits.maxConsultationsPerSession) return failureResult("budget_exhausted");
			const parsed = parseModel(config.model); const model = parsed && ctx.modelRegistry.find(...parsed);
			if (!model || !ctx.modelRegistry.getAvailable().some((candidate) => modelName(candidate) === config.model)) return failureResult("unavailable");
			if (!isSupportedThinking(model, config.thinking) || !advisorCompletionOptions(model, config.thinking, config.limits.maxAdvisorOutputTokens, parentSignal ?? new AbortController().signal)) return failureResult("unsupported_thinking");
			state.run += 1; state.attempted += 1; pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled });
			try {
				const root = await resolveRoot(pi, ctx.cwd, parentSignal);
				const evidence = await buildAdvisorContext(ctx, config.limits.maxContextBytes, () => gitSnapshot(pi, ctx.cwd, parentSignal), config.security.redactKnownSecrets);
				const result = await runAdvisorLoop({ registry: ctx.modelRegistry, model, config, root, ...evidence, signal: parentSignal });
				if (!result.advice) return failureResult(result.failure ?? "invalid_response", result.readOnlyToolCalls, result.usage);
				state.lastError = undefined;
				const details: AdvisorDetails = { model: config.model, durationMs: Date.now() - started, readOnlyToolCalls: result.readOnlyToolCalls, usage: result.usage, advice: result.advice };
				pi.appendEntry(ENTRY_TYPE, { attempted: state.attempted, enabled: state.enabled, outcome: result.advice.outcome });
				return { content: [{ type: "text" as const, text: formatAdvice(result.advice) }], details, usage: result.usage };
			} catch {
				return failureResult(parentSignal?.aborted ? "aborted" : "provider_error");
			}
		},
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("consult_advisor")), 0, 0); },
		renderResult(result, _options, theme) { const details = result.details as AdvisorDetails; return new Text(details?.advice ? theme.fg("success", `${details.advice.outcome}: ${details.advice.summary}`) : theme.fg("warning", details?.failure ?? "Advisor unavailable"), 0, 0); },
	});
}
