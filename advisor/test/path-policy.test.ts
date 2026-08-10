import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAllowedPath } from "../path-access.ts";
import { createPathPolicy } from "../path-policy.ts";
import { executeRepositoryTool } from "../repository-tools.ts";

// Injected rather than read from pi, so these tests no longer depend on ~/.pi (T7).
const agentDirectory = join(tmpdir(), "advisor-tests-agent-dir");

test("rejects protected, absolute, traversal, and escaping symlink paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "advisor-policy-"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "safe.txt"), "secret_token=sk_abcdefghijklmnop\nhello");
	await writeFile(join(root, ".env"), "NOPE");
	await writeFile(join(root, ".env.local"), "NOPE");
	await symlink("/etc", join(root, "escape"));
	const policy = createPathPolicy({ root, agentDirectory, additionalProtectedPaths: ["private"] });
	assert.ok((await resolveAllowedPath(policy, "src/safe.txt")).path);
	assert.equal((await resolveAllowedPath(policy, "../etc/passwd")).path, undefined);
	assert.equal((await resolveAllowedPath(policy, "/etc/passwd")).path, undefined);
	assert.equal((await resolveAllowedPath(policy, ".env")).path, undefined);
	assert.equal((await resolveAllowedPath(policy, ".env.local")).path, undefined);
	assert.equal((await resolveAllowedPath(policy, "escape/passwd")).path, undefined);
});

test("read and grep cap and redact local results", async () => {
	const root = await mkdtemp(join(tmpdir(), "advisor-tools-"));
	await writeFile(join(root, "data.txt"), "token=sk_abcdefghijklmnop\nneedle\n");
	const policy = createPathPolicy({ root, agentDirectory, additionalProtectedPaths: [] });
	const read = await executeRepositoryTool(policy, "read", { path: "data.txt" });
	assert.match(read, /REDACTED_SECRET/);
	const grep = await executeRepositoryTool(policy, "grep", { path: ".", pattern: "needle" });
	assert.match(grep, /data\.txt:2:needle/);
	const withoutRedaction = await executeRepositoryTool(createPathPolicy({ root, agentDirectory, additionalProtectedPaths: [], redactKnownSecrets: false }), "read", { path: "data.txt" });
	assert.match(withoutRedaction, /sk_abcdefghijklmnop/);
});
