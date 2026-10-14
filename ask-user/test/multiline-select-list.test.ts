// Covers the interaction state MultilineSelectList owns itself. The layout
// arithmetic it delegates to option-layout.ts is tested there and is not
// re-asserted here.
//
// This file only became possible once the constructor stopped using parameter
// properties (R2) — before that the module could not be loaded by node --test.
import assert from "node:assert/strict";
import test from "node:test";
import { type KeybindingsManager, type SelectListTheme, visibleWidth } from "@earendil-works/pi-tui";
import { type MultilineSelectItem, MultilineSelectList } from "../multiline-select-list.ts";

// Fixed sentinels rather than real key sequences: this file asserts on dispatch,
// not on the keybinding table.
const UP = "<up>";
const DOWN = "<down>";
const CONFIRM = "<confirm>";
const CANCEL = "<cancel>";

const BINDINGS: Record<string, string> = {
	[UP]: "tui.select.up",
	[DOWN]: "tui.select.down",
	[CONFIRM]: "tui.select.confirm",
	[CANCEL]: "tui.select.cancel",
};

const keybindings = { matches: (data: string, id: string) => BINDINGS[data] === id } as any as KeybindingsManager;

// Identity theme so assertions read against raw text rather than escape codes.
const theme = {
	noMatch: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
} as any as SelectListTheme;

const item = (value: string): MultilineSelectItem => ({ value, label: `Option ${value}`, description: undefined });

const listOf = (...values: string[]) => new MultilineSelectList(values.map(item), theme, keybindings);

// The selection index is private; the "→ " prefix is how it is observable.
function selectedLabel(list: MultilineSelectList): string | undefined {
	return list
		.render(80)
		.find((line) => line.startsWith("→ "))
		?.slice(2)
		.trim();
}

test("clamps setSelectedIndex at both ends", () => {
	const list = listOf("a", "b", "c");

	list.setSelectedIndex(-5);
	assert.equal(selectedLabel(list), "Option a");

	list.setSelectedIndex(99);
	assert.equal(selectedLabel(list), "Option c");

	list.setSelectedIndex(1);
	assert.equal(selectedLabel(list), "Option b");
});

test("wraps around when navigating past either end", () => {
	const list = listOf("a", "b", "c");

	list.handleInput(UP);
	assert.equal(selectedLabel(list), "Option c", "up from the first option lands on the last");

	list.handleInput(DOWN);
	assert.equal(selectedLabel(list), "Option a", "down from the last option lands on the first");

	list.handleInput(DOWN);
	assert.equal(selectedLabel(list), "Option b");
});

test("fires onSelect with the selected item and onCancel on cancel", () => {
	const list = listOf("a", "b", "c");
	const selected: MultilineSelectItem[] = [];
	let cancelled = 0;
	list.onSelect = (chosen) => selected.push(chosen);
	list.onCancel = () => cancelled++;

	list.setSelectedIndex(2);
	list.handleInput(CONFIRM);
	assert.deepEqual(
		selected.map((entry) => entry.value),
		["c"],
	);
	assert.equal(cancelled, 0);

	list.handleInput(CANCEL);
	assert.equal(cancelled, 1);
	assert.equal(selected.length, 1, "cancelling does not also select");
});

test("renders the no-match text for an empty item list", () => {
	const lines = listOf().render(80);

	assert.deepEqual(lines, ["  No matching options"]);
});

test("marks only the selected row with the arrow prefix", () => {
	const list = listOf("a", "b", "c");
	list.setSelectedIndex(1);

	const lines = list.render(80);

	assert.equal(
		lines.filter((line) => line.startsWith("→ ")).length,
		1,
		"exactly one row carries the selection prefix",
	);
	assert.equal(lines[1], "→ Option b");
	assert.ok(lines[0]?.startsWith("  ") && !lines[0].startsWith("→ "), "unselected rows keep the two-space prefix");
	assert.ok(lines[2]?.startsWith("  ") && !lines[2].startsWith("→ "));
});

test("renders wrapped descriptions in an aligned continuation column", () => {
	const list = new MultilineSelectList(
		[
			{
				value: "first",
				label: "First choice",
				description: "one two three four five six seven eight",
			},
			{
				value: "second",
				label: "Second choice",
				description: "one two three four five six seven eight",
			},
		],
		theme,
		keybindings,
	);

	const lines = list.render(60);
	assert.equal(lines.length, 4);
	assert.ok(lines[0]?.startsWith("→ First choice"));
	assert.ok(lines[1]?.includes("seven eight"));
	assert.ok(lines[1]?.startsWith("  ") && !lines[1].startsWith("→ "));
	assert.ok(lines[2]?.startsWith("  Second choice"));
	assert.equal(lines[0]?.indexOf("one"), lines[1]?.indexOf("seven"));
});

test("keeps wrapped labels and descriptions aligned when their heights differ", () => {
	const list = new MultilineSelectList(
		[
			{
				value: "first",
				label: "First choice has several words that wrap",
				description: "short description",
			},
		],
		theme,
		keybindings,
	);

	const lines = list.render(60);
	assert.equal(lines.length, 2);
	assert.ok(lines[0]?.includes("short description"));
	assert.ok(lines[1]?.startsWith("  words that wrap"));
	assert.ok(!lines[1]?.includes("short description"));
});

test("keeps every rendered line within the requested width", () => {
	const list = new MultilineSelectList(
		[
			{
				value: "first",
				label: "A long option label with several words",
				description:
					"A long description with enough words to wrap across several lines and remain bounded at every terminal width.",
			},
			{
				value: "second",
				label: "Another long option label",
				description: "Another description that must remain inside the terminal width.",
			},
		],
		theme,
		keybindings,
	);

	for (const width of [1, 20, 40, 60, 80, 120]) {
		assert.ok(
			list.render(width).every((line) => visibleWidth(line) <= width),
			`line exceeds width ${width}`,
		);
	}
});

test("scrolls by complete logical options when descriptions wrap", () => {
	const description =
		"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
	const list = new MultilineSelectList(
		["first", "second", "third"].map((value) => ({ value, label: `Option ${value}`, description })),
		theme,
		keybindings,
	);

	const lines = list.render(60);
	assert.equal(lines.filter((line) => line.includes("Option")).length, 2);
	assert.ok(lines.at(-1)?.includes("(1/3)"));
});
