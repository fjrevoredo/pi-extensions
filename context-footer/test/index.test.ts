import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextFooterExtension from "../index.ts";

type Handler = (event: any, ctx?: any) => unknown;

interface FakeTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}

/** Erases styling, so layout assertions can match the plain text. */
const plainTheme: FakeTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/**
 * Records styling as visible markup, resolving each color name through a palette the way a
 * real theme does. The palette is the `matrix` theme's, where `mdHeading` and `success` are
 * both #00FF41 — a fake that echoed the requested *name* instead would report two tiers as
 * distinct while the terminal painted them identically, which is how the collision survived.
 */
const MATRIX_PALETTE: Record<string, string> = {
	accent: "#00FF41",
	dim: "#33CC55",
	error: "#FF2222",
	mdHeading: "#00FF41",
	muted: "#33CC55",
	success: "#00FF41",
	warning: "#CCFF00",
};

const markerTheme: FakeTheme = {
	fg: (color, text) => {
		const resolved = MATRIX_PALETTE[color] ?? color;
		return `<${resolved}>${text}</${resolved}>`;
	},
	bold: (text) => `<b>${text}</b>`,
};

function createHarness(theme: FakeTheme = plainTheme) {
	const handlers = new Map<string, Handler[]>();
	let footerFactory: any;
	let usage: any = { tokens: 84_000, contextWindow: 200_000, percent: 42 };
	let renderRequests = 0;
	let branchChange: (() => void) | undefined;

	const pi = {
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		async exec() {
			return { code: 0, stdout: "M  staged.ts\n M modified.ts\n?? untracked.ts\n", stderr: "", killed: false };
		},
		getThinkingLevel() {
			return "high";
		},
	} as unknown as ExtensionAPI;

	contextFooterExtension(pi);

	const ctx = {
		mode: "tui",
		cwd: "/Users/test/platform/orders-api",
		model: { provider: "anthropic", id: "claude-sonnet", contextWindow: 200_000 },
		getContextUsage: () => usage,
		sessionManager: {
			getSessionName: () => "idempotency fix",
			getEntries: () => [{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.123 } } } }],
		},
		ui: {
			setFooter(factory: unknown) {
				footerFactory = factory;
			},
		},
	};

	const footerData = {
		getGitBranch: () => "feature/PLAT-4821",
		onBranchChange(callback: () => void) {
			branchChange = callback;
			return () => {
				branchChange = undefined;
			};
		},
	};

	return {
		async start() {
			await handlers.get("session_start")![0]!({}, ctx);
			await new Promise((resolve) => setImmediate(resolve));
			const component = footerFactory({ requestRender: () => renderRequests++ }, theme, footerData);
			return component;
		},
		emit(event: string, payload: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
		get usage() {
			return usage;
		},
		set usage(value: unknown) {
			usage = value;
		},
		triggerBranchChange() {
			branchChange?.();
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

test("renders the complete two-row footer and Git summary", async () => {
	const harness = createHarness();
	const footer = await harness.start();
	const lines = footer.render(160);

	assert.equal(lines.length, 2);
	assert.match(lines[0], /orders-api/);
	assert.match(lines[0], /feature\/PLAT-4821/);
	assert.match(lines[0], /\+1 ~1 \?1/);
	assert.match(lines[0], /session: idempotency fix/);
	assert.match(lines[1], /Ready/);
	assert.match(lines[1], /CTX ████░░░░░░ 42% · 84k\/200k/);
	assert.match(lines[1], /claude-sonnet · high/);
	assert.doesNotMatch(lines[1], /anthropic\//);
	assert.match(lines[1], /\$0\.123/);
});

test("tracks agent and tool lifecycle state", async () => {
	const harness = createHarness();
	const footer = await harness.start();

	harness.emit("agent_start");
	assert.match(footer.render(160)[1], /Thinking/);

	harness.emit("tool_execution_start", { toolCallId: "call-1", toolName: "bash" });
	assert.match(footer.render(160)[1], /Running bash/);

	harness.emit("tool_execution_end", { toolCallId: "call-1", toolName: "bash" });
	assert.match(footer.render(160)[1], /Thinking/);

	harness.emit("agent_settled");
	assert.match(footer.render(160)[1], /Ready/);
	assert.ok(harness.renderRequests >= 4);
});

test("paints each context tier differently in the rendered meter", async () => {
	const harness = createHarness(markerTheme);
	const footer = await harness.start();
	const contextWindow = 1_050_000;

	// The tone always paints the percent text; below one cell's worth of usage the bar has no
	// filled cells to paint, so the percent text is what has to carry the tier.
	const toneMarkupOf = (tokens: number): string => {
		harness.usage = { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
		const line = footer.render(200)[1];
		const styled = line.match(/(?:<b>)?<([^>]+)>\d+%<\/\1>(?:<\/b>)?/);
		assert.ok(styled, `no styled percent text in: ${line}`);
		return styled[0].replace(/\d+%/, "N%");
	};

	const success = toneMarkupOf(50_000);
	const warning = toneMarkupOf(120_000);
	const orange = toneMarkupOf(210_000);
	const error = toneMarkupOf(260_000);

	assert.equal(success, "<#00FF41>N%</#00FF41>");
	assert.equal(warning, "<#CCFF00>N%</#CCFF00>");
	// The orange tier must not collapse onto the success tier's color, which is what borrowing
	// `mdHeading` did under any theme aliasing it to the success color.
	assert.equal(orange, "<b><#CCFF00>N%</#CCFF00></b>");
	assert.equal(error, "<#FF2222>N%</#FF2222>");

	assert.equal(new Set([success, warning, orange, error]).size, 4);
});

test("uses context pressure and unknown-context displays", async () => {
	const harness = createHarness();
	const footer = await harness.start();

	harness.usage = { tokens: 250_000, contextWindow: 1_000_000, percent: 25 };
	harness.emit("agent_start");
	assert.match(footer.render(160)[1], /Context pressure/);
	assert.match(footer.render(160)[1], /25%/);

	harness.usage = { tokens: null, contextWindow: 200_000, percent: null };
	assert.match(footer.render(160)[1], /CTX \?\?\?\?\?\?\?\?\?\? \?%/);
});

test("keeps the actual footer renderer within every supported width", async () => {
	const harness = createHarness();
	const footer = await harness.start();
	for (const width of [1, 20, 40, 60, 80, 120]) {
		for (const line of footer.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		}
	}
	harness.triggerBranchChange();
	assert.ok(harness.renderRequests >= 1);
});
