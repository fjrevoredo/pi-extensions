/**
 * Pure display construction for ask_user questions.
 *
 * Turning a validated question into the list of rows the user sees is a formatting
 * decision, not an interaction one, so it lives here rather than in the wizard
 * component (S3). The wizard keeps only the state machine.
 *
 * Keep this module independent from pi so it can be tested with no TUI: it imports
 * types from option-layout.ts, which is itself pi-free, rather than from
 * multiline-select-list.ts.
 */
import type { OptionLayoutItem } from "./option-layout.ts";
import { type AskUserOption, type AskUserQuestion, type FreeTextMode, SOMETHING_ELSE_VALUE } from "./validation.ts";

/** UI-only option representation consumed by MultilineSelectList. */
export interface DisplayOption {
	item: OptionLayoutItem;
	optionValue: string;
	optionLabel: string;
	responseType: AskUserOption["responseType"];
	freeTextMode?: FreeTextMode;
	freeTextPlaceholder?: string;
}

export const SOMETHING_ELSE_LABEL = "Something else";
const RECOMMENDED_SUFFIX = " (recommended)";
const EDITOR_MODE_SUFFIX = " (multi-line editor)";

/**
 * Build the display rows for one question.
 *
 * The built-in "Something else" fallback is always appended last, so the explicit
 * options keep the order the model supplied and the escape hatch is always in the
 * same place for the user.
 */
export function buildDisplayOptions(question: AskUserQuestion): DisplayOption[] {
	const options: DisplayOption[] = question.options.map((option) => ({
		item: {
			value: option.value,
			// The suffix is display-only: optionLabel keeps the raw label so results
			// and the review screen never echo it back.
			label:
				question.recommendedOptionValue === option.value ? `${option.label}${RECOMMENDED_SUFFIX}` : option.label,
			description: option.description,
		},
		optionValue: option.value,
		optionLabel: option.label,
		responseType: option.responseType,
		...(option.responseType === "freeText"
			? {
					freeTextMode: option.freeTextMode,
					freeTextPlaceholder: option.freeTextPlaceholder,
				}
			: {}),
	}));

	options.push({
		item: {
			value: SOMETHING_ELSE_VALUE,
			label: SOMETHING_ELSE_LABEL,
			// Editor mode is called out so the user knows a multi-line editor opens
			// rather than a single-line input.
			description:
				question.somethingElseMode === "editor"
					? `${question.somethingElsePlaceholder}${EDITOR_MODE_SUFFIX}`
					: question.somethingElsePlaceholder,
		},
		optionValue: SOMETHING_ELSE_VALUE,
		optionLabel: SOMETHING_ELSE_LABEL,
		responseType: "freeText",
		freeTextMode: question.somethingElseMode,
		freeTextPlaceholder: question.somethingElsePlaceholder,
	});

	return options;
}
