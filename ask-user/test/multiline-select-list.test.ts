// Covers the interaction state MultilineSelectList owns itself. The layout
// arithmetic it delegates to option-layout.ts is tested there and is not
// re-asserted here.
//
// This file only became possible once the constructor stopped using parameter
// properties (R2) — before that the module could not be loaded by node --test.
import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager, SelectListTheme } from "@earendil-works/pi-tui";
import { MultilineSelectList, type MultilineSelectItem } from "../multiline-select-list.ts";

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

// biome-ignore lint/suspicious/noExplicitAny: test fake for a pi boundary type (R6).
const keybindings = { matches: (data: string, id: string) => BINDINGS[data] === id } as any as KeybindingsManager;

// Identity theme so assertions read against raw text rather than escape codes.
const theme = {
	noMatch: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	// biome-ignore lint/suspicious/noExplicitAny: test fake for a pi boundary type (R6).
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
	assert.ok(
		lines[0]?.startsWith("  ") && !lines[0].startsWith("→ "),
		"unselected rows keep the two-space prefix",
	);
	assert.ok(lines[2]?.startsWith("  ") && !lines[2].startsWith("→ "));
});
