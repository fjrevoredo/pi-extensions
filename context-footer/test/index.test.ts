import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextFooterExtension from "../index.ts";

type Handler = (event: any, ctx?: any) => unknown;

function createHarness() {
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

	const theme = {
		fg: (_color: string, text: string) => text,
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
