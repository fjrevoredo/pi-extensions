import assert from "node:assert/strict";
import test from "node:test";
import { getVisibleOptionWindow, layoutOptions, type OptionLayoutItem } from "../option-layout.ts";

const item = (label: string, description?: string): OptionLayoutItem => ({
	value: label.toLowerCase().replace(/\s+/gu, "-"),
	label,
	description,
});

test("keeps the 32-cell baseline and grows up to two-fifths of the row", () => {
	assert.equal(layoutOptions([item("A short option")], { availableWidth: 80 }).columnWidth, 32);
	assert.equal(layoutOptions([item("A label that is deliberately longer than thirty two cells")], { availableWidth: 120 }).columnWidth, 48);
	assert.equal(layoutOptions([item("x".repeat(100))], { availableWidth: 200 }).columnWidth, 80);
});

test("uses one shared width for all options and includes the recommendation suffix", () => {
	const layout = layoutOptions(
		[
			item("Use version 0.0.2853 (recommended)"),
			item("Use a shorter version"),
		],
		{ availableWidth: 120 },
	);

	assert.equal(layout.columnWidth, "Use version 0.0.2853 (recommended)".length);
	assert.equal(layout.rows[0]?.lines.join(" "), "Use version 0.0.2853 (recommended)");
	assert.equal(layout.rows[1]?.lines.join(" "), "Use a shorter version");
});

test("wraps labels to three lines and adds an ellipsis only when content remains", () => {
	const layout = layoutOptions(
		[
			item("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"),
		],
		{ availableWidth: 80 },
	);
	const row = layout.rows[0]!;

	assert.equal(row.lines.length, 3);
	assert.ok(row.lines[2]!.endsWith("..."));
	assert.ok(row.lines.every((line) => line.length <= layout.columnWidth));
});

test("keeps long recommended labels visibly truncated instead of hard-clipped", () => {
	const layout = layoutOptions(
		[
			item("Use the extremely long staged rollout strategy with regional checkpoints, automated rollback guards, dependency validation, and post-deployment verification (recommended)"),
		],
		{ availableWidth: 80 },
	);
	const row = layout.rows[0]!;
	assert.equal(row.lines.length, 3);
	assert.ok(row.lines.at(-1)!.endsWith("..."));
});

test("keeps labels with long unbroken tokens and Unicode within width", () => {
	const layout = layoutOptions(
		[
			item("supercalifragilisticexpialidocious"),
			item("Deploy 日本語 🚀 safely"),
		],
		{ availableWidth: 100 },
	);

	for (const row of layout.rows) {
		assert.ok(row.lines.length <= 3);
		assert.ok(row.lines.every((line) => line.length > 0 && line.length <= layout.columnWidth));
	}
});

test("keeps descriptions on the first line only when useful space remains", () => {
	const wide = layoutOptions([item("A short option", "Supporting description")], { availableWidth: 120 });
	assert.equal(wide.rows[0]?.description, "Supporting description");

	const narrow = layoutOptions([item("A short option", "Supporting description")], { availableWidth: 20 });
	assert.equal(narrow.rows[0]?.description, undefined);
});

test("uses complete logical options in the eight-row visible window", () => {
	const layout = layoutOptions(
		[
			item("one two three four five six seven eight nine ten"),
			item("short"),
			item("another short"),
			item("last"),
		],
		{ availableWidth: 50, maxVisibleRows: 3 },
	);

	const first = getVisibleOptionWindow(layout, 0);
	assert.equal(first.startIndex, 0);
	assert.equal(first.endIndex, 1);
	assert.equal(first.hasNext, true);

	const last = getVisibleOptionWindow(layout, 3);
	assert.equal(last.endIndex, 4);
	assert.equal(last.hasPrevious, true);
	assert.equal(last.rows.at(-1)?.item.value, "last");
});

test("shrinks safely when the terminal cannot support the 32-cell baseline", () => {
	const layout = layoutOptions([item("A label that cannot fit")], { availableWidth: 20 });
	assert.ok(layout.columnWidth < 32);
	assert.ok(layout.columnWidth <= Math.floor(20 * (2 / 5)));
	assert.ok(layout.rows[0]!.lines.every((line) => line.length <= layout.columnWidth));
});
