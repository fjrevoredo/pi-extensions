import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	combineFooterSegments,
	findFittingCombination,
	formatContextMeter,
	formatGitSummary,
	getContextTone,
	getCumulativeCost,
	joinFooterSegments,
	parseGitStatus,
	truncateSegment,
} from "../format.ts";

test("uses hard token thresholds instead of context-window percentages", () => {
	assert.equal(getContextTone({ tokens: 0, contextWindow: 1_000_000, percent: 0 }), "success");
	assert.equal(getContextTone({ tokens: 99_999, contextWindow: 1_000_000, percent: 9.9999 }), "success");
	assert.equal(getContextTone({ tokens: 100_000, contextWindow: 1_000_000, percent: 10 }), "warning");
	assert.equal(getContextTone({ tokens: 199_999, contextWindow: 1_000_000, percent: 19.9999 }), "warning");
	assert.equal(getContextTone({ tokens: 200_000, contextWindow: 1_000_000, percent: 20 }), "orange");
	assert.equal(getContextTone({ tokens: 200_000, contextWindow: 200_000, percent: 100 }), "orange");
	assert.equal(getContextTone({ tokens: 249_999, contextWindow: 1_000_000, percent: 24.9999 }), "orange");
	assert.equal(getContextTone({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }), "error");
	assert.equal(getContextTone({ tokens: 250_000, contextWindow: 2_000_000, percent: 12.5 }), "error");
});

test("renders known and unknown context meters", () => {
	assert.deepEqual(formatContextMeter({ tokens: 84_000, contextWindow: 200_000, percent: 42 }), {
		filled: "████",
		empty: "░░░░░░",
		percentText: "42%",
		tokensText: "84k/200k",
		tone: "success",
	});

	for (const usage of [
		undefined,
		{ tokens: null, contextWindow: 200_000, percent: null },
		{ tokens: 1, percent: 1 },
	]) {
		const meter = formatContextMeter(usage);
		assert.equal(meter.tone, "unknown");
		assert.equal(meter.empty, "??????????");
		assert.equal(meter.percentText, "?%");
	}
});

test("parses git porcelain status without double-counting conflicts", () => {
	const summary = parseGitStatus("M  staged.ts\n M modified.ts\nMM both.ts\n?? new.ts\nUU conflict.ts\n");
	assert.deepEqual(summary, { staged: 2, modified: 2, untracked: 1, conflicted: 1 });
	assert.equal(formatGitSummary(summary), "+2 ~2 ?1 !1");
	assert.equal(parseGitStatus(""), undefined);
});

test("sums only finite assistant-message costs", () => {
	assert.equal(
		getCumulativeCost([
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.12 } } } },
			{ type: "message", message: { role: "user", usage: { cost: { total: 100 } } } },
			{ type: "message", message: { role: "assistant", usage: { cost: { total: Number.NaN } } } },
			{ type: "custom" },
		]),
		0.12,
	);
});

test("combines before truncating so responsive layouts can drop whole segments", () => {
	const combined = combineFooterSegments(["cwd", "branch", "session"]);
	assert.equal(combined, "cwd │ branch │ session");
	const truncated = joinFooterSegments(12, [combined]);
	assert.ok(visibleWidth(truncated) <= 12);
	assert.notEqual(truncated, combined);
});

test("never renders a line wider than its requested width", () => {
	const source = "\x1b[31mfeature/PLAT-4821-with-a-very-long-branch-name\x1b[39m";
	for (const width of [1, 20, 40, 60, 80, 120]) {
		const line = joinFooterSegments(width, [truncateSegment(source, width), "session: a very long session name"]);
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
	}
});

test("returns the widest combination that fits", () => {
	// Options within a slot are ordered widest-first, as the footer builds them.
	const slots = [["status"], ["context-full", "ctx"], ["model", undefined]];

	// Widths of the four combinations, in search order: 29, 21, 20, 12.
	assert.equal(findFittingCombination(slots, 80), "status │ context-full │ model");
	assert.equal(findFittingCombination(slots, 28), "status │ context-full");
	assert.equal(findFittingCombination(slots, 20), "status │ ctx │ model");
	assert.equal(findFittingCombination(slots, 19), "status │ ctx");
});

test("degrades the rightmost slot first so the leftmost segment survives longest", () => {
	const slots = [["keep"], ["wide-middle", "mid"], ["wide-right", undefined]];

	// At a width that could fit either "keep │ mid │ wide-right" (23) or
	// "keep │ wide-middle" (18), slot order decides: the middle slot holds its
	// widest option and the right slot drops instead.
	assert.equal(findFittingCombination(slots, 23), "keep │ wide-middle");
});

test("returns undefined when nothing fits", () => {
	const slots = [["a-very-long-status"], ["context"]];

	assert.equal(findFittingCombination(slots, 5), undefined);
	// An all-optional slot set can still collapse to the empty string.
	assert.equal(findFittingCombination([[undefined]], 0), "");
	assert.equal(findFittingCombination([], 0), "");
});
