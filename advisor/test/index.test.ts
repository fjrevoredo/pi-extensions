import assert from "node:assert/strict";
import test from "node:test";
import advisor from "../index.ts";

test("registers only the parameterless driver tool with explicit guidance", () => {
	const tools: Array<Record<string, unknown>> = [];
	const commands: string[] = [];
	const events: string[] = [];
	advisor({
		on(event: string) { events.push(event); },
		registerTool(tool: Record<string, unknown>) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
	} as never);
	assert.deepEqual(commands, ["advisor"]);
	assert.deepEqual(events.sort(), ["before_agent_start", "session_shutdown", "session_start"]);
	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, "consult_advisor");
	assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties), []);
	assert.ok((tool.promptGuidelines as string[]).every((line) => line.includes("consult_advisor")));
});
