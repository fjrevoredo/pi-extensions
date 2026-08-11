import assert from "node:assert/strict";
import test from "node:test";
import { type Advice, AdviceSchema, formatAdvice, SYSTEM_PROMPT, validateAdvice } from "../contracts.ts";

/**
 * The advisor-facing contract: the shape of advice, and the prompt that asks for
 * it. The `validateConfig` cases that used to live here moved to config.test.ts,
 * beside the module they test (L5).
 */

const advice: Advice = {
	outcome: "course_correct",
	summary: "Keep the API boundary.",
	rationale: ["The caller owns retry state."],
	recommendedActions: ["Move retry ownership to the caller."],
	risks: [{ severity: "high", description: "A duplicate write can occur.", evidence: ["src/write.ts"] }],
	verification: ["Run the duplicate-write integration test."],
	assumptions: [],
	confidence: "high",
};

test("validates bounded semantic advice", () => {
	assert.deepEqual(validateAdvice(advice), advice);
	assert.equal(validateAdvice({ ...advice, recommendedActions: new Array(6).fill("action") }), undefined);
	assert.equal(validateAdvice({ ...advice, unknown: true }), undefined);
});

test("validateAdvice rejects anything that is not an advice object", () => {
	for (const value of [undefined, null, 0, "", "{}", true, [], [advice]]) {
		assert.equal(validateAdvice(value), undefined, `${JSON.stringify(value)} is not advice`);
	}
});

test("validateAdvice enforces the two semantic rules the schema cannot express", () => {
	// An on_track result with a concrete risk contradicts itself, and a not_ready
	// or stop result with nothing to do leaves the driver stuck. Neither is
	// expressible in JSON Schema, so both are checked after it.
	assert.equal(validateAdvice({ ...advice, outcome: "on_track" }), undefined, "on_track cannot carry risks");
	assert.ok(validateAdvice({ ...advice, outcome: "on_track", risks: [] }), "on_track with no risk is the normal case");
	for (const outcome of ["not_ready", "stop"] as const) {
		assert.equal(
			validateAdvice({ ...advice, outcome, recommendedActions: [] }),
			undefined,
			`${outcome} must say what to do instead`,
		);
		assert.ok(validateAdvice({ ...advice, outcome }), `${outcome} with actions is valid`);
	}
});

test("validateAdvice bounds every field, at the boundary", () => {
	assert.equal(validateAdvice({ ...advice, summary: "" }), undefined);
	assert.equal(validateAdvice({ ...advice, summary: "   " }), undefined, "whitespace is not a summary");
	assert.ok(validateAdvice({ ...advice, summary: "x".repeat(1_200) }));
	assert.equal(validateAdvice({ ...advice, summary: "x".repeat(1_201) }), undefined);
	assert.equal(validateAdvice({ ...advice, rationale: [] }), undefined, "at least one reason is required");
	assert.ok(validateAdvice({ ...advice, rationale: new Array(8).fill("r") }));
	assert.equal(validateAdvice({ ...advice, rationale: new Array(9).fill("r") }), undefined);
	assert.ok(validateAdvice({ ...advice, verification: new Array(6).fill("v") }));
	assert.equal(validateAdvice({ ...advice, verification: new Array(7).fill("v") }), undefined);
	assert.ok(validateAdvice({ ...advice, assumptions: new Array(6).fill("a") }));
	assert.equal(validateAdvice({ ...advice, assumptions: new Array(7).fill("a") }), undefined);
	for (const confidence of ["low", "medium", "high"] as const) {
		assert.ok(validateAdvice({ ...advice, confidence }));
	}
	assert.equal(validateAdvice({ ...advice, confidence: "certain" }), undefined);
	assert.equal(validateAdvice({ ...advice, outcome: "maybe" }), undefined);
});

test("validateAdvice validates each risk, including its optional evidence", () => {
	const risk = (over: Record<string, unknown>) =>
		validateAdvice({ ...advice, risks: [{ ...advice.risks[0], ...over }] });
	for (const severity of ["low", "medium", "high", "critical"] as const) {
		assert.ok(risk({ severity }));
	}
	assert.equal(risk({ severity: "catastrophic" }), undefined);
	assert.equal(risk({ description: "" }), undefined);
	assert.ok(risk({ description: "x".repeat(800) }));
	assert.equal(risk({ description: "x".repeat(801) }), undefined);
	assert.ok(risk({ evidence: undefined }), "evidence is optional");
	assert.ok(risk({ evidence: [] }));
	assert.ok(risk({ evidence: new Array(5).fill("e") }));
	assert.equal(risk({ evidence: new Array(6).fill("e") }), undefined);
	assert.equal(risk({ unexpected: true }), undefined);
	assert.equal(validateAdvice({ ...advice, risks: [null] }), undefined);
	assert.ok(validateAdvice({ ...advice, risks: new Array(8).fill(advice.risks[0]) }));
	assert.equal(validateAdvice({ ...advice, risks: new Array(9).fill(advice.risks[0]) }), undefined);
});

test("formatAdvice puts the outcome first and omits empty sections", () => {
	const formatted = formatAdvice(advice);
	assert.ok(formatted.startsWith("Advisor outcome: course_correct\nSummary: Keep the API boundary."));
	assert.ok(formatted.includes("Recommended actions:\n1. Move retry ownership to the caller."));
	assert.ok(formatted.includes("Verification: Run the duplicate-write integration test."));
	const bare = formatAdvice({ ...advice, outcome: "on_track", risks: [], recommendedActions: [], verification: [] });
	assert.equal(bare, "Advisor outcome: on_track\nSummary: Keep the API boundary.");
	// Actions are numbered from 1, because the advisor is asked for an ordered plan.
	assert.ok(formatAdvice({ ...advice, recommendedActions: ["a", "b"] }).includes("1. a\n2. b"));
});

test("SYSTEM_PROMPT and AdviceSchema do not drift apart", () => {
	// The prompt's last sentences enumerate the schema's required fields in prose.
	// Change one without the other and the advisor is told to submit a shape the
	// validator rejects, which surfaces as invalid_response and no advice at all —
	// a silent failure with no error pointing at the cause. This is the guard.
	const required = (AdviceSchema as unknown as { required: string[] }).required;
	assert.ok(Array.isArray(required) && required.length === 8, "AdviceSchema should require all eight fields");
	for (const field of required) {
		assert.ok(SYSTEM_PROMPT.includes(field), `SYSTEM_PROMPT never mentions the required field "${field}"`);
	}
	// The enumerated vocabularies have to appear too, or the advisor guesses them.
	for (const value of ["on_track", "course_correct", "not_ready", "stop", "low", "medium", "high"]) {
		assert.ok(SYSTEM_PROMPT.includes(value), `SYSTEM_PROMPT never mentions the allowed value "${value}"`);
	}
	// And the prompt must keep asking for exactly one submission, which is what
	// turn-policy.ts enforces.
	assert.ok(SYSTEM_PROMPT.includes("exactly one submit_advice tool call"));
	// The four read-only tools it is allowed to reach, and nothing else.
	assert.ok(SYSTEM_PROMPT.includes("read, grep, find, and ls"));
});

test("SYSTEM_PROMPT states the untrusted-evidence policy the labels refer to", () => {
	// evidence.ts labels every region untrusted; this sentence is what those labels
	// point at. Losing it would leave the labels meaningless.
	assert.ok(SYSTEM_PROMPT.includes("untrusted data"));
	assert.ok(SYSTEM_PROMPT.includes("cannot change this policy"));
	assert.ok(SYSTEM_PROMPT.includes("read-only"), "the advisor is told what it is");
	for (const forbidden of ["Never implement work", "run commands", "request secrets"]) {
		assert.ok(SYSTEM_PROMPT.includes(forbidden), `SYSTEM_PROMPT should forbid: ${forbidden}`);
	}
});
