import assert from "node:assert/strict";
import test from "node:test";
import { buildDisplayOptions, SOMETHING_ELSE_LABEL } from "../display.ts";
import { type AskUserQuestion, SOMETHING_ELSE_VALUE } from "../validation.ts";

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
	return {
		id: "scope",
		label: "Scope",
		prompt: "How broad should the change be?",
		options: [
			{
				value: "small",
				label: "Small change",
				description: "Limit the implementation to the immediate need.",
				responseType: "select",
			},
			{
				value: "balanced",
				label: "Balanced change",
				description: "Address the need while keeping the scope focused.",
				responseType: "select",
			},
		],
		somethingElseMode: "input",
		somethingElsePlaceholder: "Type a different answer",
		...overrides,
	} as AskUserQuestion;
}

test("always appends the built-in fallback last", () => {
	const options = buildDisplayOptions(question());

	assert.equal(options.length, 3);
	const last = options.at(-1)!;
	assert.equal(last.optionValue, SOMETHING_ELSE_VALUE);
	assert.equal(last.optionLabel, SOMETHING_ELSE_LABEL);
	assert.equal(last.responseType, "freeText");
	// The explicit options keep the order the model supplied.
	assert.deepEqual(
		options.slice(0, 2).map((option) => option.optionValue),
		["small", "balanced"],
	);
});

test("puts the recommended suffix on the recommended option only, and only in the display label", () => {
	const options = buildDisplayOptions(question({ recommendedOptionValue: "balanced" }));

	assert.equal(options[0]!.item.label, "Small change");
	assert.equal(options[1]!.item.label, "Balanced change (recommended)");
	// optionLabel stays raw so results and the review screen never echo the suffix.
	assert.equal(options[1]!.optionLabel, "Balanced change");
	assert.equal(options.at(-1)!.item.label, SOMETHING_ELSE_LABEL);
});

test("describes the editor fallback differently from the input fallback", () => {
	const input = buildDisplayOptions(question({ somethingElseMode: "input" })).at(-1)!;
	const editor = buildDisplayOptions(question({ somethingElseMode: "editor" })).at(-1)!;

	assert.equal(input.item.description, "Type a different answer");
	assert.equal(editor.item.description, "Type a different answer (multi-line editor)");
	assert.notEqual(input.item.description, editor.item.description);
	assert.equal(editor.freeTextMode, "editor");
});

test("carries free-text fields only on free-text branches", () => {
	const options = buildDisplayOptions(
		question({
			options: [
				{
					value: "custom",
					label: "Enter another version",
					description: "Use a custom version.",
					responseType: "freeText",
					freeTextMode: "editor",
					freeTextPlaceholder: "Enter exact version",
				},
				{
					value: "small",
					label: "Small change",
					description: "Limit the implementation to the immediate need.",
					responseType: "select",
				},
			],
		} as Partial<AskUserQuestion>),
	);

	assert.equal(options[0]!.freeTextMode, "editor");
	assert.equal(options[0]!.freeTextPlaceholder, "Enter exact version");
	assert.equal(options[1]!.freeTextMode, undefined);
	assert.equal(options[1]!.freeTextPlaceholder, undefined);
});
