import assert from "node:assert/strict";
import test from "node:test";
import {
	type AdvisorToolCall,
	classifyTurn,
	isPrivateTool,
	isRepositoryTool,
	PRIVATE_TOOL_NAMES,
	PRIVATE_TOOLS,
	REPOSITORY_TOOL_NAMES,
	SUBMIT_ADVICE,
	toolCallsIn,
} from "../turn-policy.ts";

/**
 * What one advisor turn may legally do. `classifyTurn`'s checks are ordered and
 * the order is behaviour (P3), so the table below carries rows where two rules
 * apply at once.
 */

const call = (name: string, id = "c1"): AdvisorToolCall => ({ type: "toolCall", id, name, arguments: {} });
const text = (value = "thinking out loud") => ({ type: "text", text: value });

test("the private tool list is the advisor's whole reach", () => {
	assert.deepEqual(PRIVATE_TOOL_NAMES, ["read", "grep", "find", "ls", SUBMIT_ADVICE]);
	assert.equal(PRIVATE_TOOLS.length, 5, "widening this list widens the extension's blast radius");
	// Four read-only tools plus the one that ends the consultation. Nothing here
	// can edit a file, run a command, or contact the user.
	assert.deepEqual([...REPOSITORY_TOOL_NAMES], ["read", "grep", "find", "ls"]);
	for (const tool of PRIVATE_TOOLS) {
		assert.ok(tool.description.length > 0, `${tool.name} needs a description the advisor can read`);
		assert.ok(tool.parameters, `${tool.name} needs a schema`);
	}
});

test("the repository list is a separate guard, not derived from the tool list", () => {
	// Deliberately duplicated in the source: this list is what admits a call for
	// execution, so it must not silently grow when a new private tool is added.
	assert.ok(!REPOSITORY_TOOL_NAMES.includes(SUBMIT_ADVICE as never), "submitting is not a repository read");
	for (const name of REPOSITORY_TOOL_NAMES) {
		assert.ok(isPrivateTool(name), `${name} must also be a private tool`);
		assert.ok(isRepositoryTool(name));
	}
	assert.ok(isPrivateTool(SUBMIT_ADVICE));
	assert.ok(!isRepositoryTool(SUBMIT_ADVICE));
	for (const name of ["bash", "edit", "write", "ask_user", "consult_advisor", "", "READ", "read "]) {
		assert.ok(!isPrivateTool(name), `${name} must not be reachable`);
		assert.ok(!isRepositoryTool(name));
	}
});

test("toolCallsIn keeps only tool calls, in order, ignoring anything else", () => {
	assert.deepEqual(toolCallsIn([]), []);
	assert.deepEqual(toolCallsIn([text(), { type: "thinking" }, null, undefined, "raw", 7]), []);
	const calls = [call("read", "a"), call("grep", "b")];
	assert.deepEqual(toolCallsIn([text(), calls[0], { type: "other" }, calls[1]]), calls);
});

interface Row {
	label: string;
	content: unknown[];
	correctionOnly: boolean;
	/** The expected kind, or the expected `submit` call id. `null` means invalid. */
	expected: null | "calls" | string;
}

const TABLE: Row[] = [
	// T8: `null` expectations are spelled out rather than left as "not the happy
	// path", so a row that starts returning a classification cannot pass quietly.
	{ label: "empty turn", content: [], correctionOnly: false, expected: null },
	{ label: "text only — the advisor is required to act", content: [text()], correctionOnly: false, expected: null },
	{ label: "one read", content: [call("read")], correctionOnly: false, expected: "calls" },
	{ label: "two reads", content: [call("read", "a"), call("grep", "b")], correctionOnly: false, expected: "calls" },
	{ label: "text plus a read", content: [text(), call("read")], correctionOnly: false, expected: "calls" },
	// An unknown name is NOT rejected here on purpose — the loop refuses it per
	// call, after the calls before it have already run and been counted.
	{
		label: "read then an unknown name",
		content: [call("read", "a"), call("bash", "b")],
		correctionOnly: false,
		expected: "calls",
	},
	{ label: "an unknown name alone", content: [call("bash")], correctionOnly: false, expected: "calls" },

	{ label: "a lone submission", content: [call(SUBMIT_ADVICE, "s")], correctionOnly: false, expected: "s" },
	{ label: "submission plus text", content: [text(), call(SUBMIT_ADVICE, "s")], correctionOnly: false, expected: "s" },
	// A submission must be the only call in its turn, and there may be only one.
	{
		label: "two submissions",
		content: [call(SUBMIT_ADVICE, "a"), call(SUBMIT_ADVICE, "b")],
		correctionOnly: false,
		expected: null,
	},
	{
		label: "submission beside a read",
		content: [call(SUBMIT_ADVICE, "s"), call("read", "r")],
		correctionOnly: false,
		expected: null,
	},
	{
		label: "read before a submission",
		content: [call("read", "r"), call(SUBMIT_ADVICE, "s")],
		correctionOnly: false,
		expected: null,
	},

	// After a rejected submission the advisor may do exactly one thing: resubmit.
	{ label: "correction: resubmit", content: [call(SUBMIT_ADVICE, "s")], correctionOnly: true, expected: "s" },
	{ label: "correction: a read instead", content: [call("read")], correctionOnly: true, expected: null },
	{
		label: "correction: two calls",
		content: [call(SUBMIT_ADVICE, "a"), call("read", "r")],
		correctionOnly: true,
		expected: null,
	},
	{ label: "correction: nothing at all", content: [text()], correctionOnly: true, expected: null },
];

test("classifyTurn admits exactly what one turn may do", () => {
	for (const row of TABLE) {
		const result = classifyTurn(row.content, { correctionOnly: row.correctionOnly });
		if (row.expected === null) {
			assert.deepEqual(result, { kind: "invalid" }, `${row.label} should be invalid`);
			continue;
		}
		if (row.expected === "calls") {
			assert.equal(result.kind, "calls", `${row.label} should be a call turn`);
			assert.deepEqual(
				result.kind === "calls" ? result.calls : undefined,
				toolCallsIn(row.content),
				`${row.label} should pass every call through in order`,
			);
			continue;
		}
		assert.equal(result.kind, "submit", `${row.label} should be a submission`);
		assert.equal(result.kind === "submit" ? result.call.id : undefined, row.expected);
	}
});

test("PRECEDENCE: the submission-shape rules are checked before the correction rule", () => {
	// Two submissions during a correction turn is invalid either way, so it proves
	// nothing on its own. This pair does: a lone submission is the *only* thing a
	// correction turn admits, and a mixed turn is refused for the shape rule that
	// would have refused it outside a correction too.
	assert.deepEqual(classifyTurn([call(SUBMIT_ADVICE, "a"), call(SUBMIT_ADVICE, "b")], { correctionOnly: true }), {
		kind: "invalid",
	});
	const lone = classifyTurn([call(SUBMIT_ADVICE, "s")], { correctionOnly: true });
	assert.equal(lone.kind, "submit");
});

test("classifyTurn never reorders or drops a call it admits", () => {
	// The loop executes these in order and counts as it goes, so the sequence is
	// part of the contract, not an implementation detail.
	const calls = [call("read", "1"), call("ls", "2"), call("grep", "3"), call("find", "4")];
	const result = classifyTurn([text(), ...calls], { correctionOnly: false });
	assert.equal(result.kind, "calls");
	assert.deepEqual(result.kind === "calls" ? result.calls.map((c) => c.id) : [], ["1", "2", "3", "4"]);
});
