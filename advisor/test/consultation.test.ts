import assert from "node:assert/strict";
import test from "node:test";
import { type AdvisorModelLookup, checkAdvisorModel, decideConsultation, FAILURE_MESSAGES } from "../consultation.ts";
import { type AdvisorConfig, defaultConfig } from "../contracts.ts";

/**
 * The gate in front of every consultation. Its guards are ordered and the order
 * is behaviour (P3), so the tests below assert **precedence** rather than
 * membership: several rows deliberately make two or three conditions true at
 * once, because a test that trips only one guard at a time cannot tell a correct
 * chain from a reordered one.
 */

function config(over: Partial<AdvisorConfig> = {}): AdvisorConfig {
	return { ...defaultConfig(), enabled: true, model: "anthropic/big", ...over };
}
const limits = (over: Partial<AdvisorConfig["limits"]>): AdvisorConfig["limits"] => ({
	...defaultConfig().limits,
	...over,
});

test("every failure has a message and the driver is always told to continue", () => {
	const keys = Object.keys(FAILURE_MESSAGES);
	assert.equal(keys.length, 9, "a new AdvisorFailure needs a message and a test row");
	for (const [key, message] of Object.entries(FAILURE_MESSAGES)) {
		assert.ok(message.length > 0, `${key} has no message`);
		assert.ok(
			message.endsWith("Continue with local evidence."),
			`${key} must hand control back to the driver: fail-open about control`,
		);
		assert.ok(message.startsWith("Advisor"), `${key} should name the advisor as the source`);
	}
});

test("the nine failure texts are exactly these, verbatim (T6)", () => {
	assert.deepEqual(FAILURE_MESSAGES, {
		disabled: "Advisor is disabled. Continue with local evidence.",
		unconfigured: "Advisor is not configured. Continue with local evidence.",
		unavailable: "Advisor model is unavailable. Continue with local evidence.",
		unsupported_thinking: "Advisor thinking level is unsupported. Continue with local evidence.",
		budget_exhausted: "Advisor consultation budget is exhausted. Continue with local evidence.",
		aborted: "Advisor consultation did not complete. Continue with local evidence.",
		timeout: "Advisor consultation did not complete. Continue with local evidence.",
		invalid_response: "Advisor did not return validated advice. Continue with local evidence.",
		provider_error: "Advisor consultation failed. Continue with local evidence.",
	});
	// Shared on purpose: from the driver's side an abort and a timeout are the same
	// event, and details.failure keeps them apart for anyone reading the transcript.
	assert.equal(FAILURE_MESSAGES.aborted, FAILURE_MESSAGES.timeout);
});

test("decideConsultation admits a configured, enabled advisor with budget left", () => {
	const result = decideConsultation({ loaded: { config: config() }, run: 0, attempted: 0 });
	assert.ok("config" in result);
	assert.equal(result.config.model, "anthropic/big", "the model is narrowed to present");
});

test("an unreadable or invalid configuration is unconfigured", () => {
	assert.deepEqual(decideConsultation({ loaded: { error: "nope" }, run: 0, attempted: 0 }), {
		failure: "unconfigured",
	});
	assert.deepEqual(decideConsultation({ loaded: {}, run: 0, attempted: 0 }), { failure: "unconfigured" });
	// An error wins even when a config is somehow also present.
	assert.deepEqual(decideConsultation({ loaded: { error: "nope", config: config() }, run: 0, attempted: 0 }), {
		failure: "unconfigured",
	});
});

test("the session override beats the file in both directions", () => {
	const off = { loaded: { config: config({ enabled: false }) }, run: 0, attempted: 0 };
	assert.deepEqual(decideConsultation(off), { failure: "disabled" });
	assert.ok("config" in decideConsultation({ ...off, sessionEnabled: true }), "/advisor on overrides the file");

	const on = { loaded: { config: config({ enabled: true }) }, run: 0, attempted: 0 };
	assert.ok("config" in decideConsultation(on));
	assert.deepEqual(decideConsultation({ ...on, sessionEnabled: false }), { failure: "disabled" });
	// undefined means "defer to the file", which is not the same as false.
	assert.ok("config" in decideConsultation({ ...on, sessionEnabled: undefined }));
});

test("PRECEDENCE: disabled is reported ahead of every later failure", () => {
	// The state the user chose, and the one they can act on, must win over a
	// consequence of it. Swapping any of these rows with a later guard would flip
	// the answer, which is what makes them precedence tests rather than coverage.
	const disabled = config({ enabled: false, model: undefined });
	assert.deepEqual(decideConsultation({ loaded: { config: disabled }, run: 0, attempted: 0 }), {
		failure: "disabled",
	});
	const alsoBroke = config({ enabled: false, model: undefined, limits: limits({ maxConsultationsPerRun: 1 }) });
	assert.deepEqual(decideConsultation({ loaded: { config: alsoBroke }, run: 99, attempted: 99 }), {
		failure: "disabled",
	});
});

test("PRECEDENCE: a missing model is reported ahead of an exhausted budget", () => {
	const noModel = config({ model: undefined, limits: limits({ maxConsultationsPerRun: 1 }) });
	assert.deepEqual(decideConsultation({ loaded: { config: noModel }, run: 99, attempted: 99 }), {
		failure: "unconfigured",
	});
});

test("both budget counters are checked at their exact boundary", () => {
	const perRun = config({ limits: limits({ maxConsultationsPerRun: 2, maxConsultationsPerSession: 100 }) });
	for (const [run, expected] of [
		[1, true],
		[2, false],
		[3, false],
	] as const) {
		const result = decideConsultation({ loaded: { config: perRun }, run, attempted: 0 });
		assert.equal("config" in result, expected, `run=${run} of 2 should ${expected ? "pass" : "fail"}`);
	}

	const perSession = config({ limits: limits({ maxConsultationsPerRun: 100, maxConsultationsPerSession: 2 }) });
	for (const [attempted, expected] of [
		[1, true],
		[2, false],
		[3, false],
	] as const) {
		const result = decideConsultation({ loaded: { config: perSession }, run: 0, attempted });
		assert.equal("config" in result, expected, `attempted=${attempted} of 2 should ${expected ? "pass" : "fail"}`);
	}
	// Either counter alone is enough to exhaust the budget.
	assert.deepEqual(decideConsultation({ loaded: { config: perRun }, run: 2, attempted: 0 }), {
		failure: "budget_exhausted",
	});
	assert.deepEqual(decideConsultation({ loaded: { config: perSession }, run: 0, attempted: 2 }), {
		failure: "budget_exhausted",
	});
});

/** A scripted registry that records what was asked of it, so short-circuiting is testable. */
function lookup(over: Partial<AdvisorModelLookup<string>> = {}) {
	const calls: string[] = [];
	const base: AdvisorModelLookup<string> = {
		find: (provider, id) => {
			calls.push(`find(${provider},${id})`);
			return `${provider}/${id}`;
		},
		availableNames: () => {
			calls.push("availableNames");
			return ["anthropic/big"];
		},
		supportsThinking: () => {
			calls.push("supportsThinking");
			return true;
		},
		canBuildCompletionOptions: () => {
			calls.push("canBuildCompletionOptions");
			return true;
		},
	};
	return { lookup: { ...base, ...over }, calls };
}

test("checkAdvisorModel resolves an available, supported model", () => {
	const { lookup: registry, calls } = lookup();
	assert.deepEqual(checkAdvisorModel("anthropic/big", registry), { model: "anthropic/big" });
	assert.deepEqual(calls, ["find(anthropic,big)", "availableNames", "supportsThinking", "canBuildCompletionOptions"]);
});

test("a reference that will not parse or will not resolve is unavailable", () => {
	const unparseable = lookup();
	assert.deepEqual(checkAdvisorModel("nonsense", unparseable.lookup), { failure: "unavailable" });
	assert.deepEqual(unparseable.calls, [], "an unparseable reference never reaches the registry at all");

	const missing = lookup({ find: () => undefined });
	assert.deepEqual(checkAdvisorModel("anthropic/big", missing.lookup), { failure: "unavailable" });
	assert.ok(!missing.calls.includes("availableNames"), "availableNames is not asked for when find failed");
});

test("a model that resolves but is not authenticated is unavailable", () => {
	const { lookup: registry } = lookup({ availableNames: () => ["openai/other"] });
	assert.deepEqual(checkAdvisorModel("anthropic/big", registry), { failure: "unavailable" });
});

test("an unsupported thinking level is reported after availability, not before", () => {
	// PRECEDENCE: this model is both unauthenticated and unable to think at the
	// configured level. `unavailable` has to win, because it is the one the user
	// can act on by authenticating.
	const both = lookup({ availableNames: () => [], supportsThinking: () => false });
	assert.deepEqual(checkAdvisorModel("anthropic/big", both.lookup), { failure: "unavailable" });
	assert.ok(!both.calls.includes("supportsThinking"), "the thinking check is not reached");

	const unsupported = lookup({ supportsThinking: () => false });
	assert.deepEqual(checkAdvisorModel("anthropic/big", unsupported.lookup), { failure: "unsupported_thinking" });
	assert.ok(
		!unsupported.calls.includes("canBuildCompletionOptions"),
		"the allocating check is skipped once the cheap one has failed",
	);

	const unbuildable = lookup({ canBuildCompletionOptions: () => false });
	assert.deepEqual(checkAdvisorModel("anthropic/big", unbuildable.lookup), { failure: "unsupported_thinking" });
	assert.ok(unbuildable.calls.includes("supportsThinking"), "both halves of the pair are consulted");
});
