/**
 * Entrypoint harness test: drives the real ask-user entrypoint with a fake `pi`,
 * no TUI and no pi runtime, and asserts on the registered tool definition.
 *
 * The tool schema and prompt text are the extension's real public API — the model is
 * the caller — so this file covers the agent-facing contract (A-series) and the
 * non-TUI execute paths. It deliberately does not instantiate AskUserWizard or touch
 * ctx.ui.custom; interactive behaviour is verified manually in pi (T10).
 *
 * Option-shape *rejection* is already covered thoroughly by validation.test.ts. This
 * file asserts structurally on the emitted JSON Schema instead of re-running TypeBox
 * validation, which would add no signal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import askUser from "../index.ts";

function registeredTool(): any {
	let definition: any;
	askUser({ registerTool: (candidate: unknown) => (definition = candidate) } as any);
	assert.ok(definition, "the extension registered no tool");
	return definition;
}

// Identity theme so assertions read against raw text rather than escape codes.
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function renderedText(component: any): string {
	return component
		.render(200)
		.map((line: string) => line.trimEnd())
		.join("\n");
}

// A payload that passes normalizeQuestions, so a failing execute() can only be the
// mode check rather than validation.
const VALID_PARAMS = {
	questions: [
		{
			id: "scope",
			prompt: "How broad should the change be?",
			options: [
				{
					value: "small",
					label: "Small change",
					description: "Limit the implementation to the immediate need.",
					responseType: "select",
				},
			],
		},
	],
};

test("registers ask_user as a sequential tool", () => {
	const tool = registeredTool();

	assert.equal(tool.name, "ask_user");
	// Sequential because the flow blocks on the user; concurrent would race (A8).
	assert.equal(tool.executionMode, "sequential");
});

test("every promptGuidelines bullet names the tool it belongs to", () => {
	const tool = registeredTool();

	assert.ok(tool.promptGuidelines.length > 0);
	for (const bullet of tool.promptGuidelines) {
		// Bullets are appended flat into a shared Guidelines section, so "this tool" is
		// unresolvable for the model (A4).
		assert.ok(bullet.includes("ask_user"), `bullet does not name ask_user: ${bullet}`);
	}
});

test("makes invalid option states unrepresentable in the schema", () => {
	const tool = registeredTool();
	const params = tool.parameters;

	assert.equal(params.type, "object");
	assert.equal(params.properties.questions.type, "array");
	assert.equal(params.properties.questions.minItems, 1);

	const options = params.properties.questions.items.properties.options;
	assert.equal(options.type, "array");
	assert.equal(options.minItems, 1);

	// Two branches, each sealed, rather than optional fields that are conditionally
	// required (A3).
	const branches = options.items.anyOf;
	assert.equal(branches.length, 2);
	for (const branch of branches) {
		assert.equal(branch.additionalProperties, false);
		for (const field of ["value", "label", "description", "responseType"]) {
			assert.ok(branch.required.includes(field), `branch is missing required field: ${field}`);
		}
	}

	const [selectBranch, freeTextBranch] = branches;
	assert.ok(!("freeTextMode" in selectBranch.properties), "the select branch must not carry free-text fields");
	assert.ok(freeTextBranch.required.includes("freeTextMode"));
	assert.ok(freeTextBranch.required.includes("freeTextPlaceholder"));
});

test("returns an error result rather than throwing outside TUI mode", async () => {
	const tool = registeredTool();

	const result = await tool.execute("call-1", VALID_PARAMS, undefined, undefined, { mode: "print" });

	const text = result.content[0].text;
	assert.match(text, /requires TUI mode/);
	assert.match(text, /ask_user/);
	assert.equal(result.details.error, text);
});

test("returns an error result naming both valid option shapes for an invalid payload", async () => {
	const tool = registeredTool();
	const params = {
		questions: [
			{
				id: "scope",
				prompt: "How broad should the change be?",
				options: [
					{
						value: "small",
						label: "Small change",
						description: "Limit the implementation to the immediate need.",
						responseType: "select",
						// Forbidden on the select branch.
						freeTextMode: "input",
					},
				],
			},
		],
	};

	const result = await tool.execute("call-1", params, undefined, undefined, { mode: "tui" });

	// A model-fixable failure is a normal result, not a throw (A5), and the message
	// shows the correct shape rather than only reporting the fault.
	const text = result.content[0].text;
	assert.match(text, /freeTextMode/);
	assert.match(text, /responseType: "select"/);
	assert.match(text, /responseType: "freeText"/);
});

test("renders cancelled, error, and answered results", () => {
	const tool = registeredTool();

	const cancelled = tool.renderResult(
		{ content: [], details: { questions: [], answers: [], cancelled: true } },
		{},
		theme,
	);
	assert.equal(renderedText(cancelled), "Cancelled");

	const errored = tool.renderResult(
		{ content: [], details: { questions: [], answers: [], cancelled: false, error: "Error: boom" } },
		{},
		theme,
	);
	assert.equal(renderedText(errored), "Error: boom");

	const answered = tool.renderResult(
		{
			content: [],
			details: {
				questions: [
					{ id: "scope", label: "Scope", recommendedOptionLabel: "Balanced change" },
					{ id: "timing", label: "Timing" },
				],
				answers: [
					{
						id: "scope",
						optionValue: "small",
						optionLabel: "Small change",
						value: "small",
						wasFreeText: false,
						acceptedRecommendation: false,
					},
					{
						id: "timing",
						optionValue: "later",
						optionLabel: "Ship later",
						value: "later",
						wasFreeText: false,
					},
				],
				cancelled: false,
			},
		},
		{},
		theme,
	);
	const text = renderedText(answered);

	assert.match(text, /Scope: Small change/);
	assert.match(text, /Timing: Ship later/);
	// The override suffix only appears where the question actually carried a recommendation.
	assert.match(text, /overrode recommendation: Balanced change/);
	assert.equal(text.match(/overrode recommendation/g)?.length, 1);
});
