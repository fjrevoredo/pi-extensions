import type { ContextUsage, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	type ContextTone,
	combineFooterSegments,
	findFittingCombination,
	fitsWidth,
	formatContextMeter,
	formatCost,
	formatCwd,
	formatGitSummary,
	type GitSummary,
	getContextTone,
	getCumulativeCost,
	getToneStyle,
	joinFooterSegments,
	parseGitStatus,
	truncateSegment,
} from "./format.ts";

type AgentPhase = "ready" | "thinking" | "running";

function themeTone(theme: Theme, tone: ContextTone, text: string): string {
	const style = getToneStyle(tone);
	const painted = theme.fg(style.color, text);
	return style.bold ? theme.bold(painted) : painted;
}

export default function contextFooterExtension(pi: ExtensionAPI): void {
	let active = false;
	let phase: AgentPhase = "ready";
	let gitSummary: GitSummary | undefined;
	let generation = 0;
	let refreshGit: (() => Promise<void>) | undefined;
	let requestRender: (() => void) | undefined;
	const activeTools = new Map<string, string>();

	const rerender = () => requestRender?.();

	function getAgentStatus(theme: Theme, tone: ContextTone): string {
		let label: string;
		if (phase === "running") {
			const names = [...activeTools.values()];
			label = names.length > 1 ? `Running ${names.length} tools` : `Running ${names[0] ?? "tool"}`;
		} else if (phase === "thinking") {
			label = "Thinking";
		} else {
			label = "Ready";
		}

		if (tone === "error") {
			return theme.fg("error", `! Context pressure · ${label}`);
		}
		if (phase === "ready") return theme.fg("success", `✓ ${label}`);
		return theme.fg("accent", `◐ ${label}`);
	}

	function buildContextSegment(
		theme: Theme,
		usage: ContextUsage | undefined,
		mode: "full" | "meter" | "percent",
	): string {
		const meter = formatContextMeter(usage);
		const tone = themeTone(theme, meter.tone, meter.percentText);
		if (mode === "percent") return `${theme.fg("muted", "CTX ")}${tone}`;

		const bar = themeTone(theme, meter.tone, meter.filled) + theme.fg("dim", meter.empty);
		const base = `${theme.fg("muted", "CTX ")}${bar} ${tone}`;
		return mode === "full" && meter.tokensText ? `${base} ${theme.fg("muted", `· ${meter.tokensText}`)}` : base;
	}

	pi.on("session_start", (_event, ctx) => {
		generation++;
		activeTools.clear();
		phase = "ready";
		gitSummary = undefined;
		active = ctx.mode === "tui";
		refreshGit = undefined;
		requestRender = undefined;

		if (!active) return;

		let refreshInFlight = false;
		let refreshPending = false;
		const sessionGeneration = generation;
		const refresh = async (): Promise<void> => {
			if (sessionGeneration !== generation) return;
			if (refreshInFlight) {
				refreshPending = true;
				return;
			}

			refreshInFlight = true;
			try {
				const result = await pi.exec("git", ["status", "--porcelain=v1"], {
					cwd: ctx.cwd,
					timeout: 2_000,
				});
				if (sessionGeneration !== generation) return;
				gitSummary = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
				rerender();
			} catch {
				if (sessionGeneration === generation) {
					gitSummary = undefined;
					rerender();
				}
			} finally {
				refreshInFlight = false;
				if (refreshPending && sessionGeneration === generation) {
					refreshPending = false;
					void refresh();
				}
			}
		};
		refreshGit = refresh;

		ctx.ui.setFooter((tui, theme, footerData) => {
			let disposed = false;
			const request = () => {
				if (!disposed && sessionGeneration === generation) tui.requestRender();
			};
			requestRender = request;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				request();
				void refresh();
			});

			const component: Component & { dispose(): void } = {
				render(width: number): string[] {
					const cwd = theme.fg("dim", formatCwd(ctx.cwd));
					const branch = footerData.getGitBranch();
					const branchText = branch ? theme.fg("muted", branch) : undefined;
					const gitText = formatGitSummary(gitSummary);
					const gitSegment = gitText ? theme.fg(gitSummary?.conflicted ? "error" : "warning", gitText) : undefined;
					const sessionName = ctx.sessionManager.getSessionName();
					const sessionSegment = sessionName ? theme.fg("dim", `session: ${sessionName}`) : undefined;

					const topOptions = [
						[cwd, branchText, gitSegment, sessionSegment],
						[cwd, branchText, gitSegment],
						[cwd, branchText],
						[cwd],
					];
					const topCandidate = topOptions
						.map((segments) => combineFooterSegments(segments))
						.find((line) => fitsWidth(line, width));
					const top = topCandidate ? joinFooterSegments(width, [topCandidate]) : truncateSegment(cwd, width);

					const usage = ctx.getContextUsage();
					const tone = getContextTone(usage);
					const status = truncateSegment(getAgentStatus(theme, tone), Math.max(8, Math.floor(width * 0.42)));
					const contextOptions = [
						buildContextSegment(theme, usage, "full"),
						buildContextSegment(theme, usage, "meter"),
						buildContextSegment(theme, usage, "percent"),
					];
					const model = ctx.model;
					const thinking = pi.getThinkingLevel();
					const modelOptions = model
						? [theme.fg("muted", `${model.id} · ${thinking}`), theme.fg("muted", model.id), undefined]
						: [undefined];
					const cost = theme.fg("muted", formatCost(getCumulativeCost(ctx.sessionManager.getEntries())));

					const bottom = findFittingCombination(
						[[status], contextOptions, modelOptions, [cost, undefined]],
						width,
					);

					return [top, bottom ?? truncateSegment(buildContextSegment(theme, usage, "percent"), width)];
				},
				invalidate(): void {},
				dispose(): void {
					disposed = true;
					unsubscribeBranch();
					if (requestRender === request) requestRender = undefined;
				},
			};
			return component;
		});

		void refresh();
	});

	pi.on("session_shutdown", () => {
		generation++;
		active = false;
		activeTools.clear();
		refreshGit = undefined;
		requestRender = undefined;
	});

	pi.on("agent_start", () => {
		if (!active) return;
		phase = "thinking";
		rerender();
	});

	pi.on("agent_settled", () => {
		if (!active) return;
		activeTools.clear();
		phase = "ready";
		rerender();
		void refreshGit?.();
	});

	pi.on("tool_execution_start", (event) => {
		if (!active) return;
		activeTools.set(event.toolCallId, event.toolName);
		phase = "running";
		rerender();
	});

	pi.on("tool_execution_end", (event) => {
		if (!active) return;
		activeTools.delete(event.toolCallId);
		phase = activeTools.size > 0 ? "running" : "thinking";
		rerender();
	});

	pi.on("model_select", () => rerender());
	pi.on("thinking_level_select", () => rerender());
	pi.on("session_info_changed", () => rerender());
}
