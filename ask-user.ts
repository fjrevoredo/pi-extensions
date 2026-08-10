/**
 * ask_user
 *
 * A TUI-only clarification tool for pi.
 *
 * Design goals:
 * - keep the tool stateless outside a single execute() call
 * - always offer a built-in "Something else" free-text escape hatch
 * - allow explicit free-text branches with custom labels inside options[]
 * - keep the model-facing contract clean and predictable
 */
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	Container,
	Editor,
	type EditorTheme,
	type Focusable,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	defaultFreeTextPlaceholder,
	normalizeQuestions,
	SOMETHING_ELSE_VALUE,
	type AskUserOption,
	type AskUserQuestion,
	type FreeTextMode,
} from "./ask-user/validation.ts";
import { MultilineSelectList, type MultilineSelectItem } from "./ask-user/multiline-select-list.ts";

/**
 * Structured answer returned by the tool.
 *
 * - optionValue / optionLabel identify which branch the user selected
 * - value is what the model should consume
 * - text is present only for free-text branches
 */
interface AskUserAnswer {
	id: string;
	optionValue: string;
	optionLabel: string;
	value: string;
	text?: string;
	wasFreeText: boolean;
	acceptedRecommendation?: boolean;
}

interface AskUserDetails {
	title?: string;
	intro?: string;
	questions: AskUserQuestion[];
	answers: AskUserAnswer[];
	cancelled: boolean;
	error?: string;
}

/** Tracks which free-text branch is currently being edited. */
interface FreeTextTarget {
	questionId: string;
	optionValue: string;
	optionLabel: string;
	mode: FreeTextMode;
	placeholder: string;
}

/** UI-only option representation used by MultilineSelectList. */
interface DisplayOption {
	item: MultilineSelectItem;
	optionValue: string;
	optionLabel: string;
	responseType: AskUserOption["responseType"];
	freeTextMode?: FreeTextMode;
	freeTextPlaceholder?: string;
}

// Model-facing schema for explicit options. The branches are deliberately strict:
// every explicit option declares its response type, and conditional fields are only
// available on the matching branch.
const AskUserOptionCommonSchema = {
	value: Type.String({ description: "Stable value returned when this explicit option is selected" }),
	label: Type.String({ description: "Display label shown to the user" }),
	description: Type.String({ description: "Supporting text shown under the option" }),
};

const AskUserSelectOptionSchema = Type.Object(
	{
		...AskUserOptionCommonSchema,
		responseType: Type.Literal("select", {
			description: "Fixed selection; do not include freeTextMode or freeTextPlaceholder",
		}),
	},
	{ additionalProperties: false },
);

const AskUserFreeTextOptionSchema = Type.Object(
	{
		...AskUserOptionCommonSchema,
		responseType: Type.Literal("freeText", {
			description: "Open a text field after this explicit option is selected",
		}),
		freeTextMode: StringEnum(["input", "editor"] as const, {
			description: "Free-text entry mode for this explicit option",
		}),
		freeTextPlaceholder: Type.String({
			description: "Non-empty placeholder or hint text for this explicit option",
		}),
	},
	{ additionalProperties: false },
);

const AskUserOptionSchema = Type.Union([AskUserSelectOptionSchema, AskUserFreeTextOptionSchema], {
	description:
		"Use the select branch for fixed choices or the freeText branch with both free-text fields. Do not mix fields between branches.",
});

// Model-facing schema for each question. Defaults are resolved in normalizeQuestions().
const AskUserQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for this question" }),
	label: Type.Optional(Type.String({ description: "Short label used in summaries and the review screen; defaults to id" })),
	prompt: Type.String({ description: "Full question shown to the user" }),
	options: Type.Array(AskUserOptionSchema, {
		description:
			"Explicit options available to the user before the built-in Something else fallback. Keep this list concise and mutually clear.",
		minItems: 1,
	}),
	somethingElseMode: Type.Optional(
		StringEnum(["input", "editor"] as const, {
			description: "Free-text entry mode for the built-in Something else fallback that is always present",
		}),
	),
	somethingElsePlaceholder: Type.Optional(
		Type.String({
			description: "Placeholder or hint text for the built-in Something else fallback",
		}),
	),
	recommendedOptionValue: Type.Optional(
		Type.String({
			description:
				"Value of the recommended explicit option for this question. Must match one of options[].value and cannot target the built-in Something else fallback.",
		}),
	),
	recommendationRationale: Type.Optional(
		Type.String({ description: "Brief rationale shown when a recommendation is provided" }),
	),
});

// Top-level tool input schema.
const AskUserParamsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional title shown at the top of the wizard" })),
	intro: Type.Optional(Type.String({ description: "Optional introductory text shown before the first question" })),
	questions: Type.Array(AskUserQuestionSchema, {
		description:
			"One or more single-select questions to ask the user in one synchronous flow. Related clarifications should usually be batched together here.",
		minItems: 1,
	}),
});

type AskUserParams = Static<typeof AskUserParamsSchema>;

/** Build the structured details object persisted on the tool result message. */
function createDetails(
	questions: AskUserQuestion[],
	answers: AskUserAnswer[],
	options?: {
		title?: string;
		intro?: string;
		cancelled?: boolean;
		error?: string;
	},
): AskUserDetails {
	return {
		title: options?.title,
		intro: options?.intro,
		questions,
		answers,
		cancelled: options?.cancelled ?? false,
		error: options?.error,
	};
}

function createToolResult(text: string, details: AskUserDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

/** Return a normal tool result for validation/runtime errors instead of throwing. */
function createErrorResult(message: string, params?: { title?: string; intro?: string; questions?: AskUserQuestion[] }) {
	return createToolResult(
		message,
		createDetails(params?.questions ?? [], [], {
			title: params?.title,
			intro: params?.intro,
			error: message,
		}),
	);
}

function createSelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

/**
 * Single-run wizard component used by ctx.ui.custom(...).
 *
 * The wizard keeps all interaction state in memory for the duration of one tool call.
 * Nothing is persisted across turns or sessions.
 */
class AskUserWizard extends Container implements Focusable {
	private _focused = false;
	private activeFocusableChild: Focusable | null = null;
	private readonly answers = new Map<string, AskUserAnswer>();
	private readonly titleText: string;
	private questionIndex = 0;
	// Minimal state machine:
	// - select: choose among explicit options + built-in Something else
	// - free-text-input/editor: capture text for the chosen free-text branch
	// - review: final confirmation step for multi-question runs
	private state: "select" | "free-text-input" | "free-text-editor" | "review" = "select";
	private validationMessage: string | undefined;
	private selectList: MultilineSelectList | null = null;
	private input: Input | null = null;
	private editor: Editor | null = null;
	private activeFreeTextTarget: FreeTextTarget | null = null;

	get focused(): boolean {
		return this._focused;
	}

	// Focus must be propagated to the active child Input/Editor so IME cursor placement works.
	set focused(value: boolean) {
		this._focused = value;
		if (this.activeFocusableChild) {
			this.activeFocusableChild.focused = value;
		}
	}

	// Written out rather than declared as parameter properties: parameter properties
	// are not erasable syntax, and a module containing them cannot be loaded by
	// node --test at all (R2).
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (details: AskUserDetails) => void;
	private readonly title: string | undefined;
	private readonly intro: string | undefined;
	private readonly questions: AskUserQuestion[];

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (details: AskUserDetails) => void,
		title: string | undefined,
		intro: string | undefined,
		questions: AskUserQuestion[],
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.title = title;
		this.intro = intro;
		this.questions = questions;
		this.titleText = title?.trim() || "Ask User";
		this.rebuild();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		if (this.state === "select") {
			if ((matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) && this.questionIndex > 0) {
				this.questionIndex -= 1;
				this.validationMessage = undefined;
				this.state = "select";
				this.rebuild();
				return;
			}
			this.selectList?.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.state === "free-text-input") {
			if (matchesKey(data, Key.shift("tab"))) {
				this.validationMessage = undefined;
				this.state = "select";
				this.activeFreeTextTarget = null;
				this.rebuild();
				return;
			}
			this.input?.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.state === "free-text-editor") {
			if (matchesKey(data, Key.shift("tab"))) {
				this.validationMessage = undefined;
				this.state = "select";
				this.activeFreeTextTarget = null;
				this.rebuild();
				return;
			}
			this.editor?.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.state === "review") {
			if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				this.questionIndex = this.questions.length - 1;
				this.validationMessage = undefined;
				this.state = "select";
				this.rebuild();
				return;
			}
		}
	}

	private rebuild(): void {
		this.clear();
		this.selectList = null;
		this.input = null;
		this.editor = null;
		this.setActiveFocusableChild(null);

		this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.titleText)), 1, 0));

		if (this.intro?.trim()) {
			this.addChild(new Text(this.theme.fg("muted", this.intro.trim()), 1, 0));
		}

		if (this.questions.length > 1) {
			this.addChild(
				new Text(
					this.theme.fg(
						"dim",
						`Question ${Math.min(this.questionIndex + 1, this.questions.length)} of ${this.questions.length}`,
					),
					1,
					0,
				),
			);
		}

		this.addChild(new Spacer(1));

		if (this.state === "review") {
			this.buildReviewState();
		} else {
			this.buildQuestionState();
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("dim", this.getFooterHint()), 1, 0));
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		this.invalidate();
		this.tui.requestRender();
	}

	private buildQuestionState(): void {
		const question = this.getCurrentQuestion();
		this.addChild(new Text(this.theme.fg("text", question.prompt), 1, 0));
		this.addChild(new Text(this.theme.fg("muted", `${question.label}`), 1, 0));
		this.addChild(new Spacer(1));

		if (this.state === "select") {
			this.buildSelectState(question);
			return;
		}

		if (this.state === "free-text-input") {
			this.buildFreeTextInputState();
			return;
		}

		this.buildFreeTextEditorState();
	}

	/**
	 * Render the option list for the current question.
	 * MultilineSelectList grows its shared label column from the 32-cell
	 * baseline up to two-fifths of the available row, then wraps labels to
	 * three lines before applying the final ellipsis fallback.
	 */
	private buildSelectState(question: AskUserQuestion): void {
		const displayOptions = this.buildDisplayOptions(question);
		const selectList = new MultilineSelectList(
			displayOptions.map((option) => option.item),
			createSelectListTheme(this.theme),
			this.keybindings,
		);

		const currentAnswer = this.answers.get(question.id);
		if (currentAnswer) {
			const selectedIndex = displayOptions.findIndex((option) => option.optionValue === currentAnswer.optionValue);
			selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
		} else if (question.recommendedOptionValue) {
			const recommendedIndex = displayOptions.findIndex((option) => option.optionValue === question.recommendedOptionValue);
			selectList.setSelectedIndex(recommendedIndex >= 0 ? recommendedIndex : 0);
		}

		selectList.onSelect = (item) => {
			const selected = displayOptions.find((option) => option.item.value === item.value);
			if (!selected) return;

			if (selected.responseType === "freeText") {
				this.activeFreeTextTarget = this.createFreeTextTarget(question.id, selected);
				this.validationMessage = undefined;
				this.state = this.activeFreeTextTarget.mode === "editor" ? "free-text-editor" : "free-text-input";
				this.rebuild();
				return;
			}

			this.answers.set(question.id, {
				id: question.id,
				optionValue: selected.optionValue,
				optionLabel: selected.optionLabel,
				value: selected.optionValue,
				wasFreeText: false,
				acceptedRecommendation: question.recommendedOptionValue
					? selected.optionValue === question.recommendedOptionValue
					: undefined,
			});
			this.advance();
		};
		selectList.onCancel = () => {
			this.cancel();
		};

		this.selectList = selectList;
		this.addChild(selectList);

		if (question.recommendedOptionValue && question.recommendationRationale) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					this.theme.fg("accent", this.theme.bold("Recommendation Rationale")) +
						"\n" +
						this.theme.fg("muted", question.recommendationRationale),
					1,
					0,
				),
			);
		}
	}

	/**
	 * Convert the normalized question into the exact option list shown in the UI.
	 *
	 * Explicit options always appear first. The built-in Something else fallback is appended last.
	 */
	private buildDisplayOptions(question: AskUserQuestion): DisplayOption[] {
		const options: DisplayOption[] = question.options.map((option) => ({
			item: {
				value: option.value,
				label: question.recommendedOptionValue === option.value ? `${option.label} (recommended)` : option.label,
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
				label: "Something else",
				description:
					question.somethingElseMode === "editor"
						? `${question.somethingElsePlaceholder} (multi-line editor)`
						: question.somethingElsePlaceholder,
			},
			optionValue: SOMETHING_ELSE_VALUE,
			optionLabel: "Something else",
			responseType: "freeText",
			freeTextMode: question.somethingElseMode,
			freeTextPlaceholder: question.somethingElsePlaceholder,
		});

		return options;
	}

	/** Build the runtime target used by the free-text capture states. */
	private createFreeTextTarget(questionId: string, option: DisplayOption): FreeTextTarget {
		const mode = option.freeTextMode ?? "input";
		return {
			questionId,
			optionValue: option.optionValue,
			optionLabel: option.optionLabel,
			mode,
			placeholder: option.freeTextPlaceholder ?? defaultFreeTextPlaceholder(mode),
		};
	}

	/** Reuse a previous free-text answer when the user revisits the same branch. */
	private getSavedFreeTextValue(target: FreeTextTarget): string | undefined {
		const currentAnswer = this.answers.get(target.questionId);
		if (!currentAnswer?.wasFreeText || currentAnswer.optionValue !== target.optionValue) {
			return undefined;
		}
		return currentAnswer.text ?? currentAnswer.value;
	}

	private getQuestionById(questionId: string): AskUserQuestion | undefined {
		return this.questions.find((candidate) => candidate.id === questionId);
	}

	/** Render the single-line free-text capture state for the active branch. */
	private buildFreeTextInputState(): void {
		const target = this.activeFreeTextTarget;
		if (!target) {
			this.state = "select";
			this.rebuild();
			return;
		}

		const input = new Input();
		const savedValue = this.getSavedFreeTextValue(target);
		if (savedValue) {
			input.setValue(savedValue);
		}
		input.onSubmit = (value) => {
			this.submitFreeTextAnswer(value);
		};
		this.input = input;
		this.addChild(new Text(this.theme.fg("muted", `${target.optionLabel} — ${target.placeholder}`), 1, 0));
		this.addChild(input);
		this.setActiveFocusableChild(input);
		this.addValidationMessage();
	}

	/** Render the multi-line free-text capture state for the active branch. */
	private buildFreeTextEditorState(): void {
		const target = this.activeFreeTextTarget;
		if (!target) {
			this.state = "select";
			this.rebuild();
			return;
		}

		const editorTheme: EditorTheme = {
			borderColor: (text: string) => this.theme.fg("accent", text),
			selectList: createSelectListTheme(this.theme),
		};
		const editor = new Editor(this.tui, editorTheme);
		const savedValue = this.getSavedFreeTextValue(target);
		if (savedValue) {
			editor.setText(savedValue);
		}
		editor.onSubmit = (value) => {
			this.submitFreeTextAnswer(value);
		};
		this.editor = editor;
		this.addChild(new Text(this.theme.fg("muted", `${target.optionLabel} — ${target.placeholder}`), 1, 0));
		this.addChild(editor);
		this.setActiveFocusableChild(editor);
		this.addValidationMessage();
	}

	/** Multi-question runs end with a review screen before final submission. */
	private buildReviewState(): void {
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Review answers")), 1, 0));
		this.addChild(new Spacer(1));

		for (const question of this.questions) {
			const answer = this.answers.get(question.id);
			if (!answer) {
				this.addChild(new Text(this.theme.fg("warning", `${question.label}: unanswered`), 1, 0));
				continue;
			}

			let suffix = "";
			if (answer.acceptedRecommendation === true) {
				suffix = this.theme.fg("success", " (accepted recommendation)");
			} else if (answer.acceptedRecommendation === false && question.recommendedOptionLabel) {
				suffix = this.theme.fg("warning", ` (overrode recommendation: ${question.recommendedOptionLabel})`);
			}

			const answerText = answer.wasFreeText
				? `${this.theme.fg("muted", `${answer.optionLabel}: `)}${this.theme.fg("text", answer.text ?? answer.value)}`
				: this.theme.fg("text", answer.optionLabel);
			this.addChild(
				new Text(`${this.theme.fg("muted", `${question.label}: `)}${answerText}${suffix}`, 1, 0),
			);
		}
	}

	private addValidationMessage(): void {
		if (!this.validationMessage) return;
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("warning", this.validationMessage), 1, 0));
	}

	private getFooterHint(): string {
		if (this.state === "select") {
			if (this.questions.length > 1 && this.questionIndex > 0) {
				return "↑↓ navigate • enter select • shift+tab/← back • esc cancel";
			}
			return "↑↓ navigate • enter select • esc cancel";
		}
		if (this.state === "free-text-input" || this.state === "free-text-editor") {
			return "enter submit • shift+tab back • esc cancel";
		}
		return "enter submit • shift+tab/← back • esc cancel";
	}

	private getCurrentQuestion(): AskUserQuestion {
		return this.questions[this.questionIndex]!;
	}

	private setActiveFocusableChild(child: Focusable | null): void {
		this.activeFocusableChild = child;
		if (this.activeFocusableChild) {
			this.activeFocusableChild.focused = this.focused;
		}
	}

	/** Finalize the currently active free-text branch and store the structured answer. */
	private submitFreeTextAnswer(rawValue: string): void {
		const target = this.activeFreeTextTarget;
		if (!target) {
			this.validationMessage = "Missing free-text target.";
			this.state = "select";
			this.rebuild();
			return;
		}

		const text = rawValue.trim();
		if (!text) {
			this.validationMessage = "Please enter a response or go back.";
			this.rebuild();
			return;
		}

		const question = this.getQuestionById(target.questionId);
		this.answers.set(target.questionId, {
			id: target.questionId,
			optionValue: target.optionValue,
			optionLabel: target.optionLabel,
			value: text,
			text,
			wasFreeText: true,
			acceptedRecommendation: question?.recommendedOptionValue
				? target.optionValue === question.recommendedOptionValue
				: undefined,
		});
		this.activeFreeTextTarget = null;
		this.validationMessage = undefined;
		this.advance();
	}

	private advance(): void {
		if (this.questions.length === 1) {
			this.submit();
			return;
		}

		if (this.questionIndex < this.questions.length - 1) {
			this.questionIndex += 1;
			this.state = "select";
			this.activeFreeTextTarget = null;
			this.validationMessage = undefined;
			this.rebuild();
			return;
		}

		this.state = "review";
		this.activeFreeTextTarget = null;
		this.validationMessage = undefined;
		this.rebuild();
	}

	private submit(): void {
		this.done(
			createDetails(this.questions, Array.from(this.answers.values()), {
				title: this.title,
				intro: this.intro,
			}),
		);
	}

	private cancel(): void {
		this.done(
			createDetails(this.questions, Array.from(this.answers.values()), {
				title: this.title,
				intro: this.intro,
				cancelled: true,
			}),
		);
	}
}

/** Build compact model-facing text that summarizes the final answers. */
function buildCompletionText(details: AskUserDetails): string {
	if (details.error) {
		return details.error;
	}
	if (details.cancelled) {
		return "User cancelled ask_user";
	}
	if (details.answers.length === 0) {
		return "User submitted ask_user with no answers";
	}

	const lines = details.answers.map((answer) => {
		const question = details.questions.find((candidate) => candidate.id === answer.id);
		const questionLabel = question?.label ?? answer.id;
		let summary = `${questionLabel}: `;
		if (answer.wasFreeText) {
			summary += `${answer.optionLabel} -> ${answer.text ?? answer.value}`;
		} else {
			summary += `user selected: ${answer.optionLabel}`;
		}

		if (answer.acceptedRecommendation === true) {
			summary += " (accepted recommendation)";
		} else if (answer.acceptedRecommendation === false && question?.recommendedOptionLabel) {
			summary += ` (overrode recommendation: ${question.recommendedOptionLabel})`;
		}
		return summary;
	});

	return `User answers:\n- ${lines.join("\n- ")}`;
}

export default function askUser(pi: ExtensionAPI) {
	// Register a single sequential tool because the flow is synchronous and user-blocking.
	//
	// Example tool call shape:
	// {
	//   title: "Clarify rollout plan",
	//   intro: "A few decisions will help me choose the safest implementation path.",
	//   questions: [
	//     {
	//       id: "scope",
	//       label: "Scope",
	//       prompt: "How broad should the change be?",
	//       options: [
	//         {
	//           value: "small",
	//           label: "Small change",
	//           description: "Limit the implementation to the immediate need.",
	//           responseType: "select",
	//         },
	//         {
	//           value: "balanced",
	//           label: "Balanced change",
	//           description: "Address the need while keeping the scope focused.",
	//           responseType: "select",
	//         },
	//         {
	//           value: "archive-all",
	//           label: "Archive all completed changes",
	//           description: "Apply the bulk action explicitly as one fixed choice.",
	//           responseType: "select",
	//         },
	//         {
	//           value: "missing_case",
	//           label: "The options are missing something",
	//           description: "Explain what is missing or how the question should change.",
	//           responseType: "freeText",
	//           freeTextMode: "editor",
	//           freeTextPlaceholder: "Explain what is missing or how the question should change",
	//         },
	//       ],
	//       somethingElseMode: "input",
	//       somethingElsePlaceholder: "Type a different answer or explain why none of the options fit",
	//       recommendedOptionValue: "balanced",
	//       recommendationRationale: "This improves the behavior without taking on unnecessary risk right now.",
	//     },
	//   ],
	// }
	pi.registerTool({
		name: "ask_user",
		label: "AskUser",
		description:
			"Ask the user one or more single-select clarifying questions in the TUI. The flow is synchronous and blocking, always includes a built-in Something else free-text path, and supports strict explicit select/free-text option branches plus recommended options with rationale.",
		promptSnippet:
			"Ask the user one or more strict single-select questions in the TUI. Every explicit option needs responseType and description; free-text branches also need freeTextMode and freeTextPlaceholder. The UI always includes a built-in Something else free-text path.",
		promptGuidelines: [
			"Use ask_user when you need explicit user input to proceed and the decision can be expressed as one or more single-select questions.",
			"Batch related clarifying questions into a single ask_user call instead of spreading them across multiple turns.",
			"Keep ask_user explicit option lists concise, mutually clear, and ordered in the way you want the user to review them.",
			"Every explicit option must include value, label, description, and responseType: use responseType=select for fixed choices or responseType=freeText with both freeTextMode and freeTextPlaceholder for text branches.",
			"Never include freeTextMode or freeTextPlaceholder on responseType=select options, and do not omit responseType.",
			"If ask_user returns a validation error, correct the reported option shape and do not retry the unchanged invalid payload.",
			"ask_user always provides a built-in free-text Something else escape hatch, so do not add a generic fallback option yourself.",
			"Use explicit ask_user options with responseType=freeText when you want a custom-labeled text branch in addition to the built-in Something else fallback.",
			"Use ask_user.somethingElseMode and ask_user.somethingElsePlaceholder when you want to tune the built-in Something else fallback.",
			"Use ask_user.recommendedOptionValue only when one explicit option is meaningfully preferable, and provide a brief ask_user.recommendationRationale.",
			"For bulk workflows, add an explicit fixed option such as archive-all; never infer multiple selections from a free-text response.",
			"Do not target the built-in Something else fallback with ask_user.recommendedOptionValue; recommendations should point only at explicit options.",
		],
		parameters: AskUserParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalized = normalizeQuestions(params);
			if ("error" in normalized) {
				return createErrorResult(normalized.error, {
					title: params.title,
					intro: params.intro,
				});
			}

			if (ctx.mode !== "tui") {
				return createErrorResult("Error: ask_user requires TUI mode", {
					title: params.title,
					intro: params.intro,
					questions: normalized.questions,
				});
			}

			const details = await ctx.ui.custom<AskUserDetails>((tui, theme, keybindings, done) => {
				return new AskUserWizard(tui, theme, keybindings, done, params.title, params.intro, normalized.questions);
			});

			return createToolResult(buildCompletionText(details), details);
		},

		renderCall(args, theme) {
			const title = typeof args.title === "string" && args.title.trim().length > 0 ? ` ${args.title.trim()}` : "";
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const labels = questions
				.slice(0, 4)
				.map((question) => {
					if (!question || typeof question !== "object") return "?";
					const label =
						typeof (question as { label?: unknown }).label === "string"
							? (question as { label: string }).label
							: undefined;
					const id = typeof (question as { id?: unknown }).id === "string" ? (question as { id: string }).id : undefined;
					return label || id || "?";
				})
				.join(", ");
			const suffix = questions.length > 4 ? ", ..." : "";
			let text = theme.fg("toolTitle", theme.bold("ask_user")) + theme.fg("muted", title);
			text += theme.fg("dim", ` • ${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels}${suffix})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const textPart = result.content.find((part) => part.type === "text");
				return new Text(textPart?.type === "text" ? textPart.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", details.error), 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				const question = details.questions.find((candidate) => candidate.id === answer.id);
				const questionLabel = question?.label ?? answer.id;
				const status = theme.fg("success", "✓ ");
				const prefix = theme.fg("accent", `${questionLabel}: `);
				const value = answer.wasFreeText
					? theme.fg("muted", `${answer.optionLabel}: `) + theme.fg("text", answer.text ?? answer.value)
					: theme.fg("text", answer.optionLabel);

				let recommendation = "";
				if (answer.acceptedRecommendation === true) {
					recommendation = theme.fg("success", " (accepted recommendation)");
				} else if (answer.acceptedRecommendation === false && question?.recommendedOptionLabel) {
					recommendation = theme.fg("warning", ` (overrode recommendation: ${question.recommendedOptionLabel})`);
				}

				return `${status}${prefix}${value}${recommendation}`;
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
