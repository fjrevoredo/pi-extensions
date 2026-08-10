import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ContextTone = "success" | "warning" | "orange" | "error" | "unknown";

export interface ContextUsage {
	contextWindow?: number;
	percent?: number | null;
	tokens?: number | null;
}

export interface ContextMeter {
	empty: string;
	filled: string;
	percentText: string;
	tokensText?: string;
	tone: ContextTone;
}

export interface GitSummary {
	conflicted: number;
	modified: number;
	staged: number;
	untracked: number;
}

interface AssistantUsageEntry {
	type?: string;
	message?: {
		role?: string;
		usage?: {
			cost?: { total?: number };
		};
	};
}

const CONTEXT_CELLS = 10;
const CONTEXT_WARNING_TOKENS = 100_000;
const CONTEXT_ORANGE_TOKENS = 200_000;
const CONTEXT_ERROR_TOKENS = 250_000;
const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function formatTokenCount(value: number): string {
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

export function getContextTone(usage: ContextUsage | undefined): ContextTone {
	const tokens = usage?.tokens;
	const percent = usage?.percent;
	if (
		typeof tokens !== "number" ||
		!Number.isFinite(tokens) ||
		typeof percent !== "number" ||
		!Number.isFinite(percent) ||
		usage?.contextWindow === undefined ||
		usage.contextWindow <= 0
	) {
		return "unknown";
	}
	if (tokens >= CONTEXT_ERROR_TOKENS) return "error";
	if (tokens >= CONTEXT_ORANGE_TOKENS) return "orange";
	if (tokens >= CONTEXT_WARNING_TOKENS) return "warning";
	return "success";
}

export function formatContextMeter(usage: ContextUsage | undefined, cells = CONTEXT_CELLS): ContextMeter {
	const tone = getContextTone(usage);
	if (tone === "unknown") {
		return {
			empty: "?".repeat(cells),
			filled: "",
			percentText: "?%",
			tone,
		};
	}

	const percent = Math.max(0, Math.min(100, usage?.percent ?? 0));
	const filledCount = Math.min(cells, Math.round((percent / 100) * cells));
	const tokens = usage?.tokens;
	const contextWindow = usage?.contextWindow ?? 0;

	return {
		filled: "█".repeat(filledCount),
		empty: "░".repeat(cells - filledCount),
		percentText: `${Math.round(percent)}%`,
		tokensText:
			typeof tokens === "number" ? `${formatTokenCount(tokens)}/${formatTokenCount(contextWindow)}` : undefined,
		tone,
	};
}

export function parseGitStatus(output: string): GitSummary | undefined {
	if (!output.trim()) return undefined;

	const summary: GitSummary = { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
	for (const line of output.split("\n")) {
		if (line.length < 2) continue;
		const xy = line.slice(0, 2);
		if (xy === "??") {
			summary.untracked++;
			continue;
		}
		if (UNMERGED_CODES.has(xy)) {
			summary.conflicted++;
			continue;
		}
		if (xy[0] !== " ") summary.staged++;
		if (xy[1] !== " ") summary.modified++;
	}

	return summary.staged || summary.modified || summary.untracked || summary.conflicted ? summary : undefined;
}

export function formatGitSummary(summary: GitSummary | undefined): string | undefined {
	if (!summary) return undefined;
	const parts: string[] = [];
	if (summary.staged) parts.push(`+${summary.staged}`);
	if (summary.modified) parts.push(`~${summary.modified}`);
	if (summary.untracked) parts.push(`?${summary.untracked}`);
	if (summary.conflicted) parts.push(`!${summary.conflicted}`);
	return parts.join(" ");
}

export function getCumulativeCost(entries: Iterable<AssistantUsageEntry>): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const cost = entry.message.usage?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
	}
	return total;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(3)}`;
}

export function formatCwd(cwd: string, home = process.env.HOME ?? process.env.USERPROFILE): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export function combineFooterSegments(segments: Array<string | undefined>): string {
	return segments.filter((segment): segment is string => Boolean(segment)).join(" │ ");
}

export function joinFooterSegments(width: number, segments: Array<string | undefined>): string {
	return truncateToWidth(combineFooterSegments(segments), Math.max(0, width), "");
}

export function truncateSegment(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "…");
}

export function fitsWidth(value: string, width: number): boolean {
	return visibleWidth(value) <= width;
}
