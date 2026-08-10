import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeQuestions,
	SOMETHING_ELSE_VALUE,
	type AskUserParamsInput,
} from "../validation.ts";

const selectOption = {
	value: "fixed",
	label: "Fixed choice",
	description: "Use the fixed choice.",
	responseType: "select",
} as const;

const freeTextOption = {
	value: "custom",
	label: "Enter a custom value",
	description: "Use a value not listed above.",
	responseType: "freeText",
	freeTextMode: "input",
	freeTextPlaceholder: "Enter the exact value",
} as const;

function paramsFor(options: unknown[], questionOverrides: Record<string, unknown> = {}): AskUserParamsInput {
	return {
		questions: [
			{
				id: "q",
				label: "Question",
				prompt: "Which option should be used?",
				options,
				...questionOverrides,
			},
		],
	} as unknown as AskUserParamsInput;
}

function resultFor(options: unknown[], questionOverrides: Record<string, unknown> = {}) {
	return normalizeQuestions(paramsFor(options, questionOverrides));
}

function errorFor(option: unknown, questionOverrides: Record<string, unknown> = {}): string {
	const result = resultFor([option], questionOverrides);
	assert("error" in result, "expected normalization to fail");
	return result.error;
}

test("accepts a valid fixed-select option", () => {
	const result = resultFor([selectOption]);
	assert.deepEqual(result, {
		questions: [
			{
				id: "q",
				label: "Question",
				prompt: "Which option should be used?",
				options: [selectOption],
				somethingElseMode: "input",
				somethingElsePlaceholder: "Type a different answer or explain why the options do not fit",
			},
		],
	});
});

test("accepts explicit free-text input and editor branches", () => {
	for (const mode of ["input", "editor"] as const) {
		const option = { ...freeTextOption, freeTextMode: mode };
		const result = resultFor([option]);
		assert(!("error" in result));
		assert.equal(result.questions[0]?.options[0]?.responseType, "freeText");
		assert.equal(result.questions[0]?.options[0]?.freeTextMode, mode);
		assert.equal(result.questions[0]?.options[0]?.freeTextPlaceholder, freeTextOption.freeTextPlaceholder);
	}
});

test("rejects every forbidden free-text field on a select option", () => {
	const cases = [
		{ freeTextMode: "input" },
		{ freeTextPlaceholder: "" },
		{ freeTextMode: "editor", freeTextPlaceholder: "" },
	];

	for (const fields of cases) {
		const error = errorFor({ ...selectOption, ...fields });
		assert.match(error, /Invalid ask_user option "fixed" in question "q"/);
		assert.match(error, /responseType is "select"/);
		assert.match(error, /Use one of:/);
		for (const field of Object.keys(fields)) assert.match(error, new RegExp(field));
	}
});

test("requires all free-text fields and rejects blank placeholders", () => {
	const missingMode = { ...freeTextOption } as Record<string, unknown>;
	delete missingMode.freeTextMode;
	assert.match(errorFor(missingMode), /freeTextMode is missing/);

	const missingPlaceholder = { ...freeTextOption } as Record<string, unknown>;
	delete missingPlaceholder.freeTextPlaceholder;
	assert.match(errorFor(missingPlaceholder), /freeTextPlaceholder must be a non-empty string/);

	assert.match(errorFor({ ...freeTextOption, freeTextPlaceholder: "   " }), /freeTextPlaceholder must be a non-empty string/);
	assert.match(errorFor({ ...freeTextOption, freeTextMode: "textarea" }), /freeTextMode must be "input" or "editor"/);
});

test("requires an explicit response type and non-empty common fields", () => {
	const missingResponseType = { ...selectOption } as Record<string, unknown>;
	delete missingResponseType.responseType;
	assert.match(errorFor(missingResponseType), /responseType must be "select" or "freeText"/);

	assert.match(errorFor({ ...selectOption, responseType: "" }), /responseType must be "select" or "freeText"/);
	assert.match(errorFor({ ...selectOption, description: "" }), /missing a non-empty description/);
	assert.match(errorFor({ ...selectOption, label: "   " }), /empty label/);
	assert.match(errorFor({ ...selectOption, value: "   " }), /empty value/);
});

test("preserves built-in Something else defaults and explicit configuration", () => {
	const defaultResult = resultFor([selectOption]);
	assert(!("error" in defaultResult));
	assert.equal(defaultResult.questions[0]?.somethingElseMode, "input");

	const editorResult = resultFor([selectOption], {
		somethingElseMode: "editor",
		somethingElsePlaceholder: "Explain the alternative",
	});
	assert(!("error" in editorResult));
	assert.equal(editorResult.questions[0]?.somethingElseMode, "editor");
	assert.equal(editorResult.questions[0]?.somethingElsePlaceholder, "Explain the alternative");
});

test("preserves recommendation validation and cannot target the fallback", () => {
	const accepted = resultFor([selectOption], {
		recommendedOptionValue: "fixed",
		recommendationRationale: "This is the safest choice.",
	});
	assert(!("error" in accepted));
	assert.equal(accepted.questions[0]?.recommendedOptionLabel, "Fixed choice");

	assert.match(errorFor(selectOption, { recommendedOptionValue: "fixed" }), /both recommendedOptionValue and recommendationRationale/);
	assert.match(
		errorFor(selectOption, { recommendedOptionValue: "unknown", recommendationRationale: "Not listed." }),
		/recommends unknown explicit option value: unknown/,
	);
	assert.match(
		errorFor(selectOption, {
			recommendedOptionValue: SOMETHING_ELSE_VALUE,
			recommendationRationale: "Use the fallback.",
		}),
		/cannot target the built-in Something else fallback/,
	);
});

test("preserves duplicate, reserved, and question-level validation", () => {
	const duplicate = resultFor([selectOption, { ...selectOption, label: "Another label" }]);
	assert("error" in duplicate);
	assert.match(duplicate.error, /duplicate option value: fixed/);

	assert.match(errorFor({ ...selectOption, value: SOMETHING_ELSE_VALUE }), /reserved option value/);

	const duplicateQuestion = normalizeQuestions({
		questions: [
			{ id: "same", prompt: "First", options: [selectOption] },
			{ id: "same", prompt: "Second", options: [{ ...selectOption, value: "second" }] },
		],
	} as unknown as AskUserParamsInput);
	assert("error" in duplicateQuestion);
	assert.match(duplicateQuestion.error, /Duplicate question id: same/);
});
