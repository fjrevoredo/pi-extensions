// Pure ask_user input validation and normalization.
// Keep this module independent from pi so its contract can be tested without a TUI.

export const SOMETHING_ELSE_VALUE = "__something_else__";

export type FreeTextMode = "input" | "editor";

export interface SelectOptionInput {
	value: string;
	label: string;
	description: string;
	responseType: "select";
}

export interface FreeTextOptionInput {
	value: string;
	label: string;
	description: string;
	responseType: "freeText";
	freeTextMode: FreeTextMode;
	freeTextPlaceholder: string;
}

export type AskUserOptionInput = SelectOptionInput | FreeTextOptionInput;

export interface AskUserQuestionInput {
	id: string;
	label?: string;
	prompt: string;
	options: AskUserOptionInput[];
	somethingElseMode?: FreeTextMode;
	somethingElsePlaceholder?: string;
	recommendedOptionValue?: string;
	recommendationRationale?: string;
}

export interface AskUserParamsInput {
	title?: string;
	intro?: string;
	questions: AskUserQuestionInput[];
}

export interface SelectOption {
	value: string;
	label: string;
	description: string;
	responseType: "select";
}

export interface FreeTextOption {
	value: string;
	label: string;
	description: string;
	responseType: "freeText";
	freeTextMode: FreeTextMode;
	freeTextPlaceholder: string;
}

export type AskUserOption = SelectOption | FreeTextOption;

export interface AskUserQuestion {
	id: string;
	label: string;
	prompt: string;
	options: AskUserOption[];
	somethingElseMode: FreeTextMode;
	somethingElsePlaceholder: string;
	recommendedOptionValue?: string;
	recommendationRationale?: string;
	recommendedOptionLabel?: string;
}

function isBlank(value: unknown): boolean {
	return typeof value !== "string" || value.trim().length === 0;
}

function hasOwn(value: object, property: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, property);
}

function describeValue(value: unknown): string {
	if (value === undefined) return "missing";
	if (typeof value === "string") return JSON.stringify(value);
	return JSON.stringify(value) ?? String(value);
}

function optionShapeError(questionId: string, value: string, issue: string): string {
	return [
		`Error: Invalid ask_user option "${value}" in question "${questionId}":`,
		issue,
		"",
		"Use one of:",
		'- { value: "...", label: "...", description: "...", responseType: "select" }',
		'- { value: "...", label: "...", description: "...", responseType: "freeText", freeTextMode: "input" | "editor", freeTextPlaceholder: "..." }',
	].join("\n");
}

function defaultFreeTextPlaceholder(mode: FreeTextMode): string {
	return mode === "editor" ? "Write your answer" : "Type your answer";
}

function defaultSomethingElsePlaceholder(mode: FreeTextMode): string {
	return mode === "editor"
		? "Write a different answer or explain why the options do not fit"
		: "Type a different answer or explain why the options do not fit";
}

function normalizeOption(questionId: string, inputOption: unknown): { option: AskUserOption } | { error: string } {
	if (!inputOption || typeof inputOption !== "object") {
		return { error: `Error: Question ${questionId} contains an invalid option object` };
	}

	const option = inputOption as Partial<AskUserOptionInput> & Record<string, unknown>;
	if (isBlank(option.value)) {
		return { error: `Error: Question ${questionId} contains an option with an empty value` };
	}
	if (isBlank(option.label)) {
		return { error: `Error: Question ${questionId} contains an option with an empty label` };
	}
	if (isBlank(option.description)) {
		return { error: `Error: Question ${questionId} option ${String(option.value)} is missing a non-empty description` };
	}

	const value = option.value!.trim();
	if (value === SOMETHING_ELSE_VALUE) {
		return { error: `Error: Question ${questionId} uses reserved option value: ${SOMETHING_ELSE_VALUE}` };
	}

	const responseType = option.responseType;
	if (responseType !== "select" && responseType !== "freeText") {
		return {
			error: optionShapeError(
				questionId,
				value,
				`responseType must be "select" or "freeText"; received ${describeValue(responseType)}.`,
			),
		};
	}

	const hasFreeTextMode = hasOwn(option, "freeTextMode");
	const hasFreeTextPlaceholder = hasOwn(option, "freeTextPlaceholder");
	if (responseType === "select") {
		const forbiddenFields = [
			...(hasFreeTextMode ? ["freeTextMode"] : []),
			...(hasFreeTextPlaceholder ? ["freeTextPlaceholder"] : []),
		];
		if (forbiddenFields.length > 0) {
			return {
				error: optionShapeError(
					questionId,
					value,
					`responseType is "select", but ${forbiddenFields.join(" and ")} ${forbiddenFields.length === 1 ? "was" : "were"} provided. Remove ${forbiddenFields.join(" and ")}.`,
				),
			};
		}

		return {
			option: {
				value,
				label: option.label!.trim(),
				description: option.description!.trim(),
				responseType,
			},
		};
	}

	if (!hasFreeTextMode) {
		return {
			error: optionShapeError(questionId, value, 'responseType is "freeText", but freeTextMode is missing.'),
		};
	}
	if (option.freeTextMode !== "input" && option.freeTextMode !== "editor") {
		return {
			error: optionShapeError(
				questionId,
				value,
				`freeTextMode must be "input" or "editor"; received ${describeValue(option.freeTextMode)}.`,
			),
		};
	}
	const freeTextPlaceholder = option.freeTextPlaceholder;
	if (!hasFreeTextPlaceholder || typeof freeTextPlaceholder !== "string" || isBlank(freeTextPlaceholder)) {
		return {
			error: optionShapeError(
				questionId,
				value,
				'responseType is "freeText", but freeTextPlaceholder must be a non-empty string.',
			),
		};
	}

	return {
		option: {
			value,
			label: option.label!.trim(),
			description: option.description!.trim(),
			responseType,
			freeTextMode: option.freeTextMode,
			freeTextPlaceholder: freeTextPlaceholder.trim(),
		},
	};
}

/**
 * Validate and normalize model-provided input into the runtime shape used by the wizard.
 * This function intentionally has no dependency on pi or the TUI.
 */
export function normalizeQuestions(params: AskUserParamsInput): { questions: AskUserQuestion[] } | { error: string } {
	if (!Array.isArray(params.questions) || params.questions.length === 0) {
		return { error: "Error: No questions provided" };
	}

	const seenQuestionIds = new Set<string>();
	const normalizedQuestions: AskUserQuestion[] = [];

	for (let index = 0; index < params.questions.length; index++) {
		const inputQuestion = params.questions[index];
		const questionNumber = index + 1;

		if (!inputQuestion || typeof inputQuestion !== "object") {
			return { error: `Error: Question ${questionNumber} is invalid` };
		}
		if (isBlank(inputQuestion.id)) {
			return { error: `Error: Question ${questionNumber} is missing a non-empty id` };
		}
		const questionId = inputQuestion.id.trim();
		if (seenQuestionIds.has(questionId)) {
			return { error: `Error: Duplicate question id: ${questionId}` };
		}
		seenQuestionIds.add(questionId);

		if (isBlank(inputQuestion.prompt)) {
			return { error: `Error: Question ${questionId} is missing a non-empty prompt` };
		}
		if (!Array.isArray(inputQuestion.options) || inputQuestion.options.length === 0) {
			return { error: `Error: Question ${questionId} must provide at least one explicit option` };
		}

		const seenOptionValues = new Set<string>();
		const options: AskUserOption[] = [];
		for (const inputOption of inputQuestion.options) {
			const normalized = normalizeOption(questionId, inputOption);
			if ("error" in normalized) return normalized;
			if (seenOptionValues.has(normalized.option.value)) {
				return { error: `Error: Question ${questionId} contains duplicate option value: ${normalized.option.value}` };
			}
			seenOptionValues.add(normalized.option.value);
			options.push(normalized.option);
		}

		const hasRecommendedValue = !isBlank(inputQuestion.recommendedOptionValue);
		const hasRecommendationRationale = !isBlank(inputQuestion.recommendationRationale);
		if (hasRecommendedValue !== hasRecommendationRationale) {
			return {
				error: `Error: Question ${questionId} must provide both recommendedOptionValue and recommendationRationale together`,
			};
		}

		const recommendedOptionValue = hasRecommendedValue ? inputQuestion.recommendedOptionValue!.trim() : undefined;
		if (recommendedOptionValue === SOMETHING_ELSE_VALUE) {
			return {
				error: `Error: Question ${questionId} cannot target the built-in Something else fallback with recommendedOptionValue`,
			};
		}
		const recommendedOption = recommendedOptionValue
			? options.find((option) => option.value === recommendedOptionValue)
			: undefined;
		if (recommendedOptionValue && !recommendedOption) {
			return {
				error: `Error: Question ${questionId} recommends unknown explicit option value: ${recommendedOptionValue}`,
			};
		}

		const somethingElseMode = inputQuestion.somethingElseMode ?? "input";
		if (somethingElseMode !== "input" && somethingElseMode !== "editor") {
			return { error: `Error: Question ${questionId} has invalid somethingElseMode: ${describeValue(somethingElseMode)}` };
		}
		const normalizedQuestion: AskUserQuestion = {
			id: questionId,
			label: isBlank(inputQuestion.label) ? questionId : inputQuestion.label!.trim(),
			prompt: inputQuestion.prompt.trim(),
			options,
			somethingElseMode,
			somethingElsePlaceholder: isBlank(inputQuestion.somethingElsePlaceholder)
				? defaultSomethingElsePlaceholder(somethingElseMode)
				: inputQuestion.somethingElsePlaceholder!.trim(),
		};
		if (recommendedOptionValue && recommendedOption) {
			normalizedQuestion.recommendedOptionValue = recommendedOptionValue;
			normalizedQuestion.recommendationRationale = inputQuestion.recommendationRationale!.trim();
			normalizedQuestion.recommendedOptionLabel = recommendedOption.label;
		}
		normalizedQuestions.push(normalizedQuestion);
	}

	return { questions: normalizedQuestions };
}

export { defaultFreeTextPlaceholder };
