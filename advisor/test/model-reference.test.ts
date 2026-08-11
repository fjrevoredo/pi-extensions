import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_REFERENCE_PATTERN, modelName, parseModel } from "../model-reference.ts";

/**
 * One format with three uses that have to agree. These tests exist mostly to keep
 * them agreeing, so they assert the *relationship* between the pattern and the
 * parse as well as each one on its own.
 */

test("modelName joins provider and id with a slash", () => {
	assert.equal(modelName({ provider: "anthropic", id: "claude-x" }), "anthropic/claude-x");
	// Structurally typed on purpose (S2): anything carrying a provider and an id
	// satisfies it, which is how pi's Model<Api> fits without being imported here.
	const richer = { provider: "openai", id: "gpt-y", contextWindow: 1, maxTokens: 2, api: "openai-responses" };
	assert.equal(modelName(richer), "openai/gpt-y");
});

test("parseModel splits at the first slash and rejects the degenerate shapes", () => {
	assert.deepEqual(parseModel("anthropic/claude-x"), ["anthropic", "claude-x"]);
	assert.deepEqual(parseModel("vertex/publishers/google/gemini"), ["vertex", "publishers/google/gemini"]);
	for (const value of ["", "/", "anthropic", "/claude-x", "anthropic/", "//"]) {
		assert.equal(parseModel(value), undefined, `${JSON.stringify(value)} is not a reference`);
	}
});

test("MODEL_REFERENCE_PATTERN admits exactly two whitespace-free segments", () => {
	for (const value of ["anthropic/claude-x", "a/b", "openai/gpt-4.1-mini"]) {
		assert.ok(MODEL_REFERENCE_PATTERN.test(value), `${value} should be storable`);
	}
	for (const value of ["", "a", "/b", "a/", "a/b/c", "a b/c", "a/b c", " a/b", "a/b ", "a//b"]) {
		assert.ok(!MODEL_REFERENCE_PATTERN.test(value), `${value} should not be storable`);
	}
	// No `g` flag, so `.test` is not stateful — a shared regex with lastIndex would
	// alternate between true and false on repeated calls.
	assert.ok(MODEL_REFERENCE_PATTERN.test("a/b"));
	assert.ok(MODEL_REFERENCE_PATTERN.test("a/b"));
});

test("the pattern is the gate, so the parse never sees more than one slash", () => {
	// This is why parseModel's multi-slash tolerance is documented as unreachable
	// rather than as behaviour: validateConfig applies the pattern first, and every
	// string it admits has exactly one slash, so splitting at the first and at the
	// last are indistinguishable in production.
	const admitted = ["anthropic/claude-x", "a/b", "openai/gpt-4.1-mini", "x/y-z_1.2"];
	for (const value of admitted) {
		assert.ok(MODEL_REFERENCE_PATTERN.test(value));
		assert.equal(value.indexOf("/"), value.lastIndexOf("/"), `${value} must hold exactly one slash`);
	}
	// And a reference the pattern rejects is exactly the case where they differ.
	assert.notEqual("a/b/c".indexOf("/"), "a/b/c".lastIndexOf("/"));
	assert.ok(!MODEL_REFERENCE_PATTERN.test("a/b/c"));
});

test("modelName and parseModel round-trip every storable reference", () => {
	for (const value of ["anthropic/claude-x", "openai/gpt-y", "google/gemini-3"]) {
		const parsed = parseModel(value);
		assert.ok(parsed);
		assert.equal(modelName({ provider: parsed[0], id: parsed[1] }), value);
	}
});
