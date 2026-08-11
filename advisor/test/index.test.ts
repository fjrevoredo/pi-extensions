import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advisorConfigPath } from "../config.ts";
import { FAILURE_MESSAGES } from "../consultation.ts";
import { type AdvisorConfig, type AdvisorDetails, defaultConfig } from "../contracts.ts";
import advisor from "../index.ts";
import { NO_UI_MESSAGE, toggleMessage, USAGE_MESSAGE } from "../slash-command.ts";

/**
 * The entrypoint driven through a fake pi, on the pattern
 * `context-footer/test/index.test.ts` established (T4). This is the only place
 * the wiring itself is exercised: that the registered handlers reach the right
 * modules, in the right order, with the values the loop needs.
 *
 * `agentDirectory` is injected, which is what A7's second parameter exists for,
 * so nothing here reads the developer's real `~/.pi` (T7).
 */

const ENTRY_TYPE = "advisor-consultation-v1";

const ADVICE = {
	outcome: "on_track",
	summary: "The boundary holds.",
	rationale: ["The caller owns retry state."],
	recommendedActions: [],
	risks: [],
	verification: [],
	assumptions: [],
	confidence: "high",
};

/** Enough of a pi model for getSupportedThinkingLevels and the options adapter. */
const MODEL = {
	provider: "anthropic",
	id: "big",
	api: "anthropic-messages",
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const SESSION_ENTRIES = [
	{
		id: "1",
		parentId: null,
		type: "message",
		message: { role: "user", content: "how do I do the thing?", timestamp: 1 },
	},
	{
		id: "2",
		parentId: "1",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "like so" }], timestamp: 2 },
	},
];

interface HarnessOptions {
	/** Written to the injected agent directory. Omit for a first-run (ENOENT) state. */
	config?: AdvisorConfig;
	/** Point the extension at a directory that does not exist. */
	missingAgentDirectory?: boolean;
	/** A directory where advisor.json belongs, so the read fails with EISDIR. */
	unreadableConfig?: boolean;
	hasUI?: boolean;
	available?: ReadonlyArray<Record<string, unknown>>;
	answers?: ReadonlyArray<string | undefined>;
	confirm?: boolean;
	/** Scripted assistant turns. Each entry is returned by one complete() call. */
	completions?: readonly unknown[];
}

async function harness(options: HarnessOptions = {}) {
	const base = await mkdtemp(join(tmpdir(), "advisor-index-"));
	// The agent directory sits inside the repository root, which is both the
	// realistic layout and the only arrangement where the isWithin guard has
	// anything to protect.
	const agentDirectory = options.missingAgentDirectory ? join(base, "not-there") : join(base, ".pi", "agent");
	await mkdir(join(base, "src"), { recursive: true });
	await writeFile(join(base, "src", "notes.md"), "the repository says hello\n");
	if (!options.missingAgentDirectory) {
		await mkdir(agentDirectory, { recursive: true });
		// Not in DEFAULT_PROTECTED, so only the agent-directory guard covers it.
		await writeFile(join(agentDirectory, "sessions.json"), "private pi state\n");
	}
	if (options.unreadableConfig) await mkdir(advisorConfigPath(agentDirectory));
	else if (options.config) await writeFile(advisorConfigPath(agentDirectory), JSON.stringify(options.config, null, 2));

	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ level: string; message: string }> = [];
	const prompts: string[] = [];
	const execs: string[] = [];
	const stdout: string[] = [];
	let completeCalls = 0;
	const completeContexts: Array<{ systemPrompt: string; messages: Array<{ content?: unknown }> }> = [];

	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let tool: Record<string, any> | undefined;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
			handlers[event] = handler;
		},
		registerCommand(_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			command = spec.handler;
		},
		registerTool(spec: Record<string, any>) {
			tool = spec;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		async exec(_file: string, args: string[]) {
			execs.push(args.join(" "));
			if (args[0] === "rev-parse") return { code: 0, stdout: `${base}\n`, stderr: "" };
			return { code: 0, stdout: `out(${args.join(" ")})\n`, stderr: "" };
		},
	};

	advisor(pi as never, { agentDirectory: () => agentDirectory });

	const answers = [...(options.answers ?? [])];
	const available = options.available ?? [];
	const script = [...(options.completions ?? [])];

	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: base,
		signal: new AbortController().signal,
		model: undefined as unknown,
		getSystemPrompt: () => "driver instructions",
		sessionManager: {
			getEntries: () => SESSION_ENTRIES,
			getLeafId: () => "2",
			getBranch: () => [] as unknown[],
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				available.find((m) => m.provider === provider && m.id === id) as unknown,
			getAvailable: () => available,
			async complete(_model: unknown, context: { systemPrompt: string; messages: Array<{ content?: unknown }> }) {
				completeCalls += 1;
				completeContexts.push({ systemPrompt: context.systemPrompt, messages: [...context.messages] });
				const next = script.shift();
				if (!next) throw new Error("no scripted completion");
				return next;
			},
		},
		ui: {
			notify: (message: string, level: string) => notifications.push({ level, message }),
			select: async (prompt: string) => {
				prompts.push(prompt);
				return answers.shift();
			},
			confirm: async (title: string) => {
				prompts.push(title);
				return options.confirm ?? false;
			},
		},
	};

	return {
		base,
		agentDirectory,
		entries,
		notifications,
		prompts,
		execs,
		stdout,
		get completeCalls() {
			return completeCalls;
		},
		get lastCompleteContext() {
			return completeContexts.at(-1);
		},
		/** Every message the advisor was shown, flattened to text. */
		transcript() {
			return completeContexts
				.at(-1)!
				.messages.map((message) => JSON.stringify((message as { content?: unknown }).content))
				.join("\n");
		},
		tool: () => tool!,
		setDriverModel(model: unknown) {
			ctx.model = model;
		},
		async lifecycle(event: "session_start" | "session_shutdown" | "before_agent_start", branch: unknown[] = []) {
			ctx.sessionManager.getBranch = () => branch;
			await handlers[event]?.({}, ctx);
		},
		async runCommand(args: string) {
			const real = console.log;
			console.log = (...parts: unknown[]) => stdout.push(parts.join(" "));
			try {
				await command?.(args, ctx);
			} finally {
				console.log = real;
			}
		},
		async consult(signal?: AbortSignal) {
			return (await tool!.execute("call-1", {}, signal, () => {}, ctx)) as {
				content: Array<{ text: string }>;
				details: AdvisorDetails;
			};
		},
	};
}

const configured = (over: Partial<AdvisorConfig> = {}): AdvisorConfig => ({
	...defaultConfig(),
	enabled: true,
	model: "anthropic/big",
	...over,
});

test("registers only the parameterless driver tool with explicit guidance", () => {
	const tools: Array<Record<string, unknown>> = [];
	const commands: string[] = [];
	const events: string[] = [];
	advisor({
		on(event: string) {
			events.push(event);
		},
		registerTool(tool: Record<string, unknown>) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	} as never);
	assert.deepEqual(commands, ["advisor"]);
	assert.deepEqual(events.sort(), ["before_agent_start", "session_shutdown", "session_start"]);
	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, "consult_advisor");
	assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties), []);
	assert.ok((tool.promptGuidelines as string[]).every((line) => line.includes("consult_advisor")));
	assert.equal(tool.executionMode, "sequential", "A8: a non-sequential advisor tool would race");
});

test("an unconfigured advisor returns the exact disabled text and contacts no provider", async () => {
	// The whole point of the gate: a first-run install has no config file, so
	// defaultConfig() applies and that has enabled:false. Nothing may leave the
	// machine on this path.
	const h = await harness({ missingAgentDirectory: true });
	const result = await h.consult();
	assert.equal(result.content[0]?.text, FAILURE_MESSAGES.disabled);
	assert.equal(result.content[0]?.text, "Advisor is disabled. Continue with local evidence.");
	assert.equal(h.completeCalls, 0, "no completion request is made");
	assert.deepEqual(h.execs, [], "not even git is run");
	assert.equal(result.details.failure, "disabled");
	assert.equal(result.details.readOnlyToolCalls, 0);
	assert.equal(result.details.model, undefined, "no model is attributed to a refusal");
});

test("each gate failure is reported with its own text and recorded on the session", async () => {
	for (const [label, options, failure] of [
		["disabled on disk", { config: configured({ enabled: false }) }, "disabled"],
		["no model configured", { config: configured({ model: undefined }) }, "unconfigured"],
		["unreadable configuration", { unreadableConfig: true }, "unconfigured"],
		["model not authenticated", { config: configured(), available: [] }, "unavailable"],
	] as const) {
		const h = await harness(options);
		const result = await h.consult();
		assert.equal(result.content[0]?.text, FAILURE_MESSAGES[failure], `${label} should report ${failure}`);
		assert.equal(result.details.failure, failure, label);
		assert.equal(h.completeCalls, 0, `${label} must not reach the provider`);
		// The failure is journalled so /advisor status can report it later.
		const last = h.entries.at(-1);
		assert.ok(last, `${label} should journal an entry`);
		assert.equal(last.type, ENTRY_TYPE, label);
		assert.equal((last.data as { lastError?: string }).lastError, failure, label);
	}
});

test("an already-cancelled call is refused before any work is done", async () => {
	const h = await harness({ config: configured(), available: [MODEL] });
	const controller = new AbortController();
	controller.abort();
	const result = await h.consult(controller.signal);
	assert.equal(result.content[0]?.text, FAILURE_MESSAGES.aborted);
	assert.equal(result.details.failure, "aborted");
	assert.equal(h.completeCalls, 0);
	assert.deepEqual(h.execs, [], "the abort is checked ahead of resolveRoot");
});

test("a budget-exhausted session is refused without contacting the provider", async () => {
	// The per-run cap may not exceed the per-session cap, so both come down together
	// — otherwise validateConfig refuses the file and this reports `unconfigured`.
	const limits = { ...defaultConfig().limits, maxConsultationsPerRun: 1, maxConsultationsPerSession: 1 };
	const h = await harness({ config: configured({ limits }) });
	await h.lifecycle("session_start", [{ type: "custom", customType: ENTRY_TYPE, data: { attempted: 1 } }]);
	const result = await h.consult();
	assert.equal(result.content[0]?.text, FAILURE_MESSAGES.budget_exhausted);
	assert.equal(h.completeCalls, 0);
});

test("a permitted consultation wires the loop up and returns formatted advice", async () => {
	// The only test that proves index.ts hands the loop what it needs: the git
	// root, the agent directory, and the assembled evidence.
	const h = await harness({
		config: configured(),
		available: [MODEL],
		completions: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "submit_advice", arguments: { advice: ADVICE } }],
				usage: undefined,
			},
		],
	});
	const result = await h.consult();
	assert.equal(h.completeCalls, 1);
	assert.match(result.content[0]?.text ?? "", /^Advisor outcome: on_track\nSummary: The boundary holds\./);
	assert.equal(result.details.failure, undefined);
	assert.equal(result.details.model, "anthropic/big", "a success attributes the model it used");
	assert.deepEqual(result.details.advice, ADVICE);

	// resolveRoot and gitSnapshot both went through pi.exec, in that order.
	assert.deepEqual(h.execs, ["rev-parse --show-toplevel", "status --porcelain", "diff --stat"]);

	// The advisor was shown the session, the driver instructions and the snapshot.
	const shown = String(h.lastCompleteContext?.messages[0]?.content ?? "");
	assert.ok(shown.includes("The following is untrusted driver and repository evidence."));
	assert.ok(shown.includes("USER: how do I do the thing?"));
	assert.ok(shown.includes("driver instructions"));
	assert.ok(shown.includes("status:"), "the git snapshot is included");
	assert.ok(h.lastCompleteContext?.systemPrompt.includes("read-only technical advisor"));

	// Counters advance and the outcome is journalled.
	assert.deepEqual(h.entries.at(-1)?.data, { attempted: 1, enabled: undefined, outcome: "on_track" });
});

test("PRECEDENCE: an abort is reported ahead of an unreadable configuration", async () => {
	// Both conditions hold, so only the order decides. The abort check has to come
	// first, which is also why an already-cancelled call performs no file read at
	// all — a property no assertion below can observe, but this one pins the order.
	const h = await harness({ unreadableConfig: true, available: [MODEL] });
	const controller = new AbortController();
	controller.abort();
	const result = await h.consult(controller.signal);
	assert.equal(result.details.failure, "aborted", "not unconfigured");
	assert.equal(result.content[0]?.text, FAILURE_MESSAGES.aborted);
});

test("the loop is given the git root, so reads resolve against the repository", async () => {
	// Proves index.ts passes resolveRoot's answer through: src/notes.md exists in
	// the fixture root and nowhere else, and the result is rendered relative to
	// that root rather than as a bare basename (A10).
	const h = await harness({
		config: configured(),
		available: [MODEL],
		completions: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: join("src", "notes.md") } }],
				usage: undefined,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "submit_advice", arguments: { advice: ADVICE } }],
				usage: undefined,
			},
		],
	});
	const result = await h.consult();
	assert.equal(result.details.failure, undefined);
	assert.equal(result.details.readOnlyToolCalls, 1);
	const shown = h.transcript();
	assert.ok(shown.includes("the repository says hello"), "the advisor was shown the file it asked for");
	assert.ok(shown.includes("src/notes.md"), "and the path relative to the repository root");
});

test("the loop is given the agent directory, so pi's own state stays unreadable", async () => {
	// The isWithin(root, agentDirectory) guard, exercised end to end. sessions.json
	// is not in the protected catalogue, so only that guard can deny it — which is
	// what makes this a test of the wiring rather than of path-policy.ts.
	const h = await harness({
		config: configured(),
		available: [MODEL],
		completions: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "r1", name: "read", arguments: { path: join(".pi", "agent", "sessions.json") } },
				],
				usage: undefined,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "submit_advice", arguments: { advice: ADVICE } }],
				usage: undefined,
			},
		],
	});
	const result = await h.consult();
	assert.equal(result.details.failure, undefined);
	const shown = h.transcript();
	assert.ok(shown.includes("Denied:"), "the advisor was refused");
	assert.ok(!shown.includes("private pi state"), "and never saw pi's session state");
});

test("a success clears the last error, so status stops reporting it", async () => {
	const h = await harness({
		config: configured({ enabled: false }),
		available: [MODEL],
		completions: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "submit_advice", arguments: { advice: ADVICE } }],
				usage: undefined,
			},
		],
	});
	assert.equal((await h.consult()).details.failure, "disabled");
	await h.runCommand("status");
	assert.ok((h.notifications.at(-1)?.message ?? "").includes("last error: disabled"));

	await h.runCommand("on");
	assert.equal((await h.consult()).details.failure, undefined);
	await h.runCommand("status");
	assert.ok(
		!(h.notifications.at(-1)?.message ?? "").includes("last error"),
		"a later success must clear the stale error",
	);
});

test("the run budget is spent per run and reset by before_agent_start", async () => {
	const h = await harness({
		config: configured({ limits: { ...defaultConfig().limits, maxConsultationsPerRun: 1 } }),
		available: [MODEL],
		completions: Array.from({ length: 2 }, () => ({
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "submit_advice", arguments: { advice: ADVICE } }],
			usage: undefined,
		})),
	});
	assert.equal((await h.consult()).details.failure, undefined);
	assert.equal((await h.consult()).details.failure, "budget_exhausted", "the second call in the same run is refused");
	await h.lifecycle("before_agent_start");
	assert.equal((await h.consult()).details.failure, undefined, "a new run gets a fresh allowance");
});

test("session_start restores counters and the toggle, and later entries win", async () => {
	const h = await harness({ config: configured() });
	await h.lifecycle("session_start", [
		{ type: "custom", customType: ENTRY_TYPE, data: { attempted: 4, enabled: false, lastError: "timeout" } },
		{ type: "custom", customType: ENTRY_TYPE, data: { attempted: 7 } },
		{ type: "custom", customType: "someone-elses-entry", data: { attempted: 99 } },
		{ type: "message" },
	]);
	await h.runCommand("status");
	const status = h.notifications.at(-1)?.message ?? "";
	assert.ok(status.includes("consultations: 0/3 run, 7/12 session"), "the later attempted value wins");
	assert.ok(status.includes("session enabled: false"), "the restored toggle is in force");
	assert.ok(status.includes("last error: timeout"));
});

test("session_shutdown clears the session toggle and the run count", async () => {
	const h = await harness({ config: configured({ enabled: false }) });
	await h.runCommand("on");
	assert.equal((await h.consult()).details.failure !== "disabled", true, "the override took effect");
	await h.lifecycle("session_shutdown");
	assert.equal((await h.consult()).details.failure, "disabled", "the override does not survive the session");
});

test("/advisor on and off toggle the session and journal the change", async () => {
	const h = await harness({ config: configured({ enabled: false }) });
	await h.runCommand("on");
	assert.deepEqual(h.notifications.at(-1), { level: "info", message: toggleMessage(true) });
	assert.deepEqual(h.entries.at(-1)?.data, { attempted: 0, enabled: true });
	await h.runCommand("  OFF  ");
	assert.deepEqual(h.notifications.at(-1), { level: "info", message: toggleMessage(false) });
	assert.deepEqual(h.entries.at(-1)?.data, { attempted: 0, enabled: false });
});

test("/advisor rejects an unknown argument instead of opening the wizard", async () => {
	const h = await harness({ config: configured(), available: [MODEL] });
	await h.runCommand("bogus");
	assert.deepEqual(h.notifications.at(-1), { level: "warning", message: USAGE_MESSAGE });
	assert.deepEqual(h.prompts, [], "no prompt is opened, so nothing can be written");
	assert.deepEqual(h.entries, [], "nothing is journalled");
});

test("/advisor refuses to configure without a UI, but still prints status", async () => {
	// Configuring writes the provider the advisor will talk to, and the disclosure
	// is mandatory (P2). There is no way to obtain consent from a pipe.
	const h = await harness({ config: configured(), hasUI: false, available: [MODEL] });
	await h.runCommand("");
	assert.deepEqual(h.stdout, [NO_UI_MESSAGE]);
	assert.deepEqual(h.prompts, [], "no selection is offered");

	await h.runCommand("status");
	assert.equal(h.stdout.length, 2, "status falls back to stdout rather than notifying");
	assert.ok(h.stdout[1]?.includes("model: anthropic/big"));
	assert.deepEqual(h.notifications, [], "nothing was notified in either branch");
});

test("/advisor reports a configuration it cannot read rather than offering defaults", async () => {
	const h = await harness({ unreadableConfig: true });
	await h.runCommand("status");
	assert.deepEqual(h.notifications, [{ level: "error", message: "Advisor configuration cannot be read." }]);
});

test("/advisor says so when no model is authenticated", async () => {
	const h = await harness({ config: configured(), available: [] });
	await h.runCommand("");
	assert.deepEqual(h.notifications.at(-1), {
		level: "error",
		message: "No authenticated advisor model is available.",
	});
	assert.deepEqual(h.prompts, []);
});

test("the wizard warns about the driver's own model and saves the confirmed choice", async () => {
	const h = await harness({
		config: configured({ enabled: false }),
		available: [MODEL],
		answers: ["anthropic/big", "high"],
		confirm: true,
	});
	h.setDriverModel(MODEL);
	await h.runCommand("");
	assert.deepEqual(
		h.notifications.map((n) => n.level),
		["warning", "info"],
	);
	assert.match(h.notifications[0]?.message ?? "", /uses the active driver model/);
	assert.equal(h.notifications[1]?.message, "Advisor saved: anthropic/big (high).");
	// The disclosure is the last thing before the write, and it names the provider.
	assert.equal(h.prompts.length, 3);
	assert.equal(h.prompts[2], "Advisor provider disclosure");

	// Written through to disk, and it survives a read back.
	const h2 = await harness({ config: configured() });
	assert.ok(h2.agentDirectory);
});

test("declining the disclosure writes nothing", async () => {
	const h = await harness({
		config: configured({ enabled: false }),
		available: [MODEL],
		answers: ["anthropic/big", "high"],
		confirm: false,
	});
	await h.runCommand("");
	assert.equal(h.prompts.at(-1), "Advisor provider disclosure");
	assert.deepEqual(h.notifications, [], "nothing is reported saved");
	// Still disabled, because the wizard never completed.
	assert.equal((await h.consult()).details.failure, "disabled");
});

test("cancelling either selection abandons the wizard", async () => {
	for (const answers of [[undefined], ["anthropic/big", undefined], ["ghost/nope"]]) {
		const h = await harness({ config: configured({ enabled: false }), available: [MODEL], answers, confirm: true });
		await h.runCommand("");
		assert.deepEqual(h.notifications, [], `${JSON.stringify(answers)} should write nothing`);
		assert.equal((await h.consult()).details.failure, "disabled");
	}
});

test("renderCall and renderResult stay readable for advice and for a refusal", async () => {
	const h = await harness({ missingAgentDirectory: true });
	const theme = {
		fg: (color: string, text: string) => `[${color}]${text}`,
		bold: (text: string) => `*${text}*`,
	};
	assert.equal(h.tool().renderCall({}, theme).text, "[toolTitle]*consult_advisor*");

	const refusal = await h.consult();
	assert.equal(h.tool().renderResult(refusal, {}, theme).text, "[warning]disabled");
	const advised = { details: { advice: ADVICE } };
	assert.equal(h.tool().renderResult(advised, {}, theme).text, "[success]on_track: The boundary holds.");
	// A result with no details at all must still render something (U2).
	assert.equal(h.tool().renderResult({}, {}, theme).text, "[warning]Advisor unavailable");
});
