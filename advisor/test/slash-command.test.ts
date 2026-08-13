import assert from "node:assert/strict";
import test from "node:test";
import { type AdvisorConfig, defaultConfig } from "../contracts.ts";
import {
	type AdvisorCommand,
	CONFIG_UNAVAILABLE_MESSAGE,
	capabilityWarning,
	DISCLOSURE_TITLE,
	formatAdvisorStatus,
	MODEL_SELECT_PROMPT,
	NO_MODELS_MESSAGE,
	NO_UI_MESSAGE,
	parseAdvisorCommand,
	providerDisclosure,
	SAME_MODEL_WARNING,
	savedMessage,
	THINKING_SELECT_PROMPT,
	toggleMessage,
	USAGE_MESSAGE,
	WEAKER_MODEL_WARNING,
} from "../slash-command.ts";

/**
 * Every sentence `/advisor` puts in front of the user, plus what an argument
 * means. These are the extension's contract with the person using it, so the
 * strings are asserted verbatim rather than by shape (T6).
 */

const ARGUMENTS: Array<[string, AdvisorCommand]> = [
	// An empty argument opens the wizard — that is the documented default.
	["", { kind: "configure" }],
	[" ", { kind: "configure" }],
	["\t\n  ", { kind: "configure" }],
	["on", { kind: "toggle", enabled: true }],
	["off", { kind: "toggle", enabled: false }],
	["ON", { kind: "toggle", enabled: true }],
	["OFF", { kind: "toggle", enabled: false }],
	["  On  ", { kind: "toggle", enabled: true }],
	["\toff\n", { kind: "toggle", enabled: false }],
	["status", { kind: "status" }],
	["config", { kind: "status" }],
	["CONFIG", { kind: "status" }],
	["Status", { kind: "status" }],
	// Anything unrecognised is `unknown`, never a fall-through to the wizard: a
	// typo must not open a prompt that writes configuration.
	["bogus", { kind: "unknown" }],
	["onn", { kind: "unknown" }],
	["on off", { kind: "unknown" }],
	["off on", { kind: "unknown" }],
	["--help", { kind: "unknown" }],
	["0", { kind: "unknown" }],
	["status extra", { kind: "unknown" }],
];

test("parseAdvisorCommand trims and folds case, and never falls through to the wizard", () => {
	for (const [args, expected] of ARGUMENTS) {
		assert.deepEqual(parseAdvisorCommand(args), expected, `${JSON.stringify(args)} should parse as ${expected.kind}`);
	}
});

test("the user-facing constants are exactly these (T6)", () => {
	assert.equal(CONFIG_UNAVAILABLE_MESSAGE, "Advisor configuration is unavailable.");
	assert.equal(USAGE_MESSAGE, "Use /advisor, /advisor on, /advisor off, /advisor status, or /advisor config.");
	assert.equal(NO_UI_MESSAGE, "/advisor requires an interactive UI. Use /advisor config for current configuration.");
	assert.equal(NO_MODELS_MESSAGE, "No authenticated advisor model is available.");
	assert.equal(
		MODEL_SELECT_PROMPT,
		"Select the advisor model. Driver context and permitted repository data will be sent to its provider.",
	);
	assert.equal(THINKING_SELECT_PROMPT, "Select advisor thinking level.");
	assert.equal(DISCLOSURE_TITLE, "Advisor provider disclosure");
	assert.equal(
		SAME_MODEL_WARNING,
		"The advisor uses the active driver model. A distinct stronger model can give more independent advice.",
	);
	assert.equal(
		WEAKER_MODEL_WARNING,
		"The selected advisor has lower known context or output capacity than the active driver model.",
	);
});

test("the usage message lists every argument the parser accepts", () => {
	// A drift guard: adding an argument without documenting it leaves users unable
	// to discover it, and the usage line is the only place it is advertised.
	for (const accepted of ["/advisor on", "/advisor off", "/advisor status", "/advisor config"]) {
		assert.ok(USAGE_MESSAGE.includes(accepted), `${accepted} is missing from the usage message`);
	}
});

test("toggle, saved and disclosure messages interpolate what they promise", () => {
	assert.equal(toggleMessage(true), "Advisor is enabled for this session.");
	assert.equal(toggleMessage(false), "Advisor is disabled for this session.");
	assert.equal(savedMessage("anthropic/big", "high"), "Advisor saved: anthropic/big (high).");
	assert.equal(
		providerDisclosure("anthropic"),
		"The advisor receives selected task context and permitted repository text through anthropic. Path filtering and redaction reduce risk but are not a security sandbox. Continue?",
	);
});

test("the disclosure names the provider and refuses to oversell the filtering (P1, P2)", () => {
	const body = providerDisclosure("some-provider");
	assert.ok(body.includes("some-provider"), "the provider is the part the user cannot infer");
	assert.ok(body.includes("not a security sandbox"), "the same sentence the README and P1 headers carry");
	assert.ok(body.endsWith("Continue?"), "consent is requested, not assumed");
});

const config = (over: Partial<AdvisorConfig> = {}): AdvisorConfig => ({
	...defaultConfig(),
	enabled: true,
	model: "anthropic/big",
	...over,
});

test("the status block reports the session override and the file value separately", () => {
	const base = { config: config(), run: 1, attempted: 2 };
	const deferred = formatAdvisorStatus(base).split("\n");
	assert.ok(deferred.includes("enabled: true"), "the file value comes from formatConfig");
	assert.ok(deferred.includes("session enabled: true"), "with no override, the file value is in force");
	assert.ok(deferred.includes("consultations: 1/3 run, 2/12 session"));
	assert.ok(!deferred.some((line) => line.startsWith("last error:")), "no error line when there has been no error");

	// The two disagree exactly when /advisor on|off has been used, and which one is
	// winning is the question this block exists to answer.
	const overridden = formatAdvisorStatus({ ...base, sessionEnabled: false }).split("\n");
	assert.ok(overridden.includes("enabled: true"));
	assert.ok(overridden.includes("session enabled: false"));
});

test("the status block appends the last error only when there is one", () => {
	const status = formatAdvisorStatus({ config: config(), run: 0, attempted: 0, lastError: "timeout" });
	assert.ok(status.endsWith("\nlast error: timeout"), "the error is the last line");
	assert.equal(
		formatAdvisorStatus({ config: config(), run: 0, attempted: 0, lastError: undefined }).includes("last error"),
		false,
	);
	// The sub-reason is what makes an invalid_response actionable: six loop refusals
	// share that one word (A7).
	const detailed = formatAdvisorStatus({
		config: config(),
		run: 0,
		attempted: 0,
		lastError: "invalid_response",
		lastErrorDetail: "schema_rejected",
	});
	assert.ok(detailed.endsWith("\nlast error: invalid_response (schema_rejected)"));
	// A detail with no error to attach to shows nothing at all.
	assert.equal(
		formatAdvisorStatus({ config: config(), run: 0, attempted: 0, lastErrorDetail: "turn_budget" }).includes(
			"turn_budget",
		),
		false,
	);
});

test("the status block reflects a session override of a disabled file value", () => {
	const status = formatAdvisorStatus({
		config: config({ enabled: false }),
		sessionEnabled: true,
		run: 0,
		attempted: 0,
	}).split("\n");
	assert.ok(status.includes("enabled: false"));
	assert.ok(status.includes("session enabled: true"));
});

const model = (id: string, contextWindow: number, maxTokens: number) => ({
	provider: "p",
	id,
	contextWindow,
	maxTokens,
});

test("capabilityWarning says nothing useful when there is nothing to compare", () => {
	assert.equal(capabilityWarning(model("a", 100, 10), undefined), undefined);
});

test("capabilityWarning flags a same-name advisor and a weaker one", () => {
	const driver = model("driver", 200, 20);
	assert.equal(capabilityWarning(model("driver", 200, 20), driver), SAME_MODEL_WARNING);
	assert.equal(capabilityWarning(model("other", 100, 20), driver), WEAKER_MODEL_WARNING, "lower context");
	assert.equal(capabilityWarning(model("other", 200, 10), driver), WEAKER_MODEL_WARNING, "lower max tokens");
	assert.equal(capabilityWarning(model("other", 200, 20), driver), undefined, "equal capacity is not weaker");
	assert.equal(capabilityWarning(model("other", 400, 40), driver), undefined, "stronger is what we want");
	// Boundary: strictly-less, so matching one dimension exactly is fine.
	assert.equal(capabilityWarning(model("other", 200, 21), driver), undefined);
	assert.equal(capabilityWarning(model("other", 199, 20), driver), WEAKER_MODEL_WARNING);
});

test("PRECEDENCE: the same-model warning wins when both conditions hold", () => {
	// Only the check order decides which sentence the user sees here, so this is a
	// precedence test. The same-name case is the more actionable message: it says
	// the advisor is not independent at all, which subsumes any capacity note.
	const driver = model("driver", 999, 99);
	assert.equal(capabilityWarning(model("driver", 1, 1), driver), SAME_MODEL_WARNING);
	assert.equal(capabilityWarning(model("driver", 9_999, 999), driver), SAME_MODEL_WARNING);
});
