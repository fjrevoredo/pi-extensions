import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, validateAdvice } from "../contracts.ts";
import { validateConfig } from "../config.ts";

const advice = {
	outcome: "course_correct", summary: "Keep the API boundary.", rationale: ["The caller owns retry state."],
	recommendedActions: ["Move retry ownership to the caller."], risks: [{ severity: "high", description: "A duplicate write can occur.", evidence: ["src/write.ts"] }],
	verification: ["Run the duplicate-write integration test."], assumptions: [], confidence: "high",
};

test("validates default configuration", () => {
	assert.deepEqual(validateConfig(defaultConfig()), defaultConfig());
	assert.equal(validateConfig({ ...defaultConfig(), model: "invalid" }), undefined);
	assert.equal(validateConfig({ ...defaultConfig(), limits: { ...defaultConfig().limits, timeoutMs: 1 } }), undefined);
	assert.equal(validateConfig({ ...defaultConfig(), unexpected: true }), undefined);
	assert.equal(validateConfig({ ...defaultConfig(), security: { ...defaultConfig().security, additionalProtectedPaths: ["../secrets"] } }), undefined);
});

test("validates bounded semantic advice", () => {
	assert.deepEqual(validateAdvice(advice), advice);
	assert.equal(validateAdvice({ ...advice, outcome: "on_track", risks: advice.risks }), undefined);
	assert.equal(validateAdvice({ ...advice, recommendedActions: new Array(6).fill("action") }), undefined);
	assert.equal(validateAdvice({ ...advice, unknown: true }), undefined);
	assert.equal(validateAdvice({ ...advice, outcome: "stop", recommendedActions: [] }), undefined);
});
