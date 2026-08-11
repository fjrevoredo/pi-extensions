import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_OUTPUT_LINES, OUTPUT_TRUNCATION_NOTICE } from "../outbound-text.ts";
import { createResolvedPathPolicy, resolveAllowedPath } from "../path-access.ts";
import { PROTECTED_OR_OUTSIDE_ERROR } from "../path-policy.ts";
import { executeRepositoryTool } from "../repository-tools.ts";

/**
 * The four tools the advisor may reach. The read and grep cases here were
 * previously in path-policy.test.ts, which is not where a reader looks for them
 * (L5).
 *
 * Injected rather than read from pi, so these tests never touch ~/.pi (T7).
 */
const agentDirectory = join(tmpdir(), "advisor-tests-agent-dir");

async function fixture(options: { redact?: boolean } = {}) {
	// Deliberately the raw mkdtemp path, which on macOS reaches the directory
	// through /var -> /private/var. createResolvedPathPolicy canonicalizes it, and
	// that is what these tests are checking as much as the tools themselves.
	const root = await mkdtemp(join(tmpdir(), "advisor-tools-"));
	await mkdir(join(root, "src"));
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "node_modules", "junk.txt"), "needle");
	await writeFile(join(root, "src", "data.txt"), "token=sk_abcdefghijklmnop\nneedle\n");
	await writeFile(join(root, "top.txt"), "needle at the top\n");
	await writeFile(join(root, ".env"), "needle in a protected file\n");
	await writeFile(join(root, "logo.png"), "not really a png");
	await writeFile(join(root, "blob.bin"), Buffer.from([0x68, 0x00, 0x69]));
	const policy = await createResolvedPathPolicy({
		root,
		agentDirectory,
		additionalProtectedPaths: [],
		redactKnownSecrets: options.redact ?? true,
	});
	return { root, policy };
}

test("read returns a header, redacts by default, and can be asked not to", async () => {
	const { policy } = await fixture();
	const read = await executeRepositoryTool(policy, "read", { path: join("src", "data.txt") });
	assert.match(read, /REDACTED_SECRET/);
	assert.doesNotMatch(read, /sk_abcdefghijklmnop/);
	assert.match(read, /needle/);

	const plain = await fixture({ redact: false });
	const unredacted = await executeRepositoryTool(plain.policy, "read", { path: join("src", "data.txt") });
	assert.match(unredacted, /sk_abcdefghijklmnop/, "redaction is configurable, and off means off");
});

test("read caps a long file and says so, in the body and in the header", async () => {
	const { root, policy } = await fixture();
	await writeFile(
		join(root, "long.txt"),
		`${Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`).join("\n")}\n`,
	);
	const read = await executeRepositoryTool(policy, "read", { path: "long.txt" });
	assert.match(read.split("\n")[0] ?? "", /\(truncated\)$/, "the header flags truncation");
	assert.ok(read.endsWith(OUTPUT_TRUNCATION_NOTICE), "the notice is the last thing the advisor sees");
});

test("read refuses directories, images, and binaries rather than returning bytes", async () => {
	const { policy } = await fixture();
	await assert.rejects(() => executeRepositoryTool(policy, "read", { path: "src" }), /not a regular file/);
	await assert.rejects(() => executeRepositoryTool(policy, "read", { path: "logo.png" }), /Images are not available/);
	await assert.rejects(
		() => executeRepositoryTool(policy, "read", { path: "blob.bin" }),
		/Binary files are not available/,
	);
});

test("a denied path returns the policy message as a result, not an exception (T6)", async () => {
	const { policy } = await fixture();
	// The advisor is told plainly rather than seeing the turn fail: a refusal is
	// information it can act on, and every tool routes through the same wording.
	for (const name of ["read", "ls", "find", "grep"] as const) {
		const result = await executeRepositoryTool(policy, name, { path: ".env", pattern: "needle" });
		assert.equal(result, `Denied: ${PROTECTED_OR_OUTSIDE_ERROR}`, `${name} should deny .env`);
	}
});

test("ls marks directories, filters noise, and refuses a non-directory", async () => {
	const { policy } = await fixture();
	const listing = (await executeRepositoryTool(policy, "ls", { path: "." })).split("\n");
	assert.ok(listing.includes("src/"), "directories carry a trailing slash");
	assert.ok(listing.includes("top.txt"));
	assert.ok(!listing.includes("node_modules/"), "node_modules is filtered as noise");
	assert.ok(!listing.some((entry) => entry.startsWith(".env")), "protected entries are not even listed");
	assert.equal(await executeRepositoryTool(policy, "ls", { path: "top.txt" }), "Error: target is not a directory.");
});

test("find walks the tree, honours maxDepth, and omits protected and excluded paths", async () => {
	const { policy } = await fixture();
	const all = (await executeRepositoryTool(policy, "find", { path: "." })).split("\n");
	assert.ok(
		all.some((entry) => entry.endsWith("data.txt")),
		"nested files are found",
	);
	assert.ok(!all.some((entry) => entry.includes("node_modules")));
	assert.ok(!all.some((entry) => entry.includes(".env")));

	const shallow = (await executeRepositoryTool(policy, "find", { path: ".", maxDepth: 0 })).split("\n");
	assert.ok(shallow.includes("top.txt"));
	assert.ok(!shallow.some((entry) => entry.endsWith("data.txt")), "maxDepth 0 does not descend into src");
});

test("grep reports path, line number and text, and skips what it may not read", async () => {
	const { policy } = await fixture();
	const grep = await executeRepositoryTool(policy, "grep", { path: ".", pattern: "needle" });
	assert.match(grep, /data\.txt:2:needle/, "the line number is 1-based");
	assert.ok(!grep.includes(".env"), "a protected file is not searched");
	assert.ok(!grep.includes("node_modules"), "excluded directories are not searched");
	assert.match(
		await executeRepositoryTool(policy, "grep", { path: ".", pattern: "NEEDLE" }),
		/needle/,
		"matching is case-insensitive",
	);
});

test("grep rejects a missing, oversized, or invalid pattern instead of matching everything", async () => {
	const { policy } = await fixture();
	const short = /grep requires a short text pattern/;
	assert.match(await executeRepositoryTool(policy, "grep", { path: "." }), short);
	assert.match(await executeRepositoryTool(policy, "grep", { path: ".", pattern: "" }), short);
	assert.match(await executeRepositoryTool(policy, "grep", { path: ".", pattern: "x".repeat(201) }), short);
	// The bound is inclusive: 200 is accepted and simply finds nothing.
	assert.equal(await executeRepositoryTool(policy, "grep", { path: ".", pattern: "x".repeat(200) }), "");
	assert.match(
		await executeRepositoryTool(policy, "grep", { path: ".", pattern: "([unclosed" }),
		/grep pattern is invalid/,
	);
});

test("grep redacts matched lines on the way out", async () => {
	const { policy } = await fixture();
	const grep = await executeRepositoryTool(policy, "grep", { path: ".", pattern: "token" });
	assert.match(grep, /REDACTED_SECRET/);
	assert.doesNotMatch(grep, /sk_abcdefghijklmnop/);
});

test("every result is relative to the root, directory included", async () => {
	// A8 pinned these two at the bare filename, because the root the fixture hands
	// over is non-canonical and displayPath was taking its basename fallback for
	// every result. A10 canonicalizes the root at construction, so the directory
	// survives. Asserting the full anchored line matters here: /data\.txt:2:needle/
	// is what the pre-A8 suite asserted, and it matches the broken output too.
	const { policy } = await fixture();
	assert.match(
		await executeRepositoryTool(policy, "grep", { path: ".", pattern: "needle" }),
		/^src[/\\]data\.txt:2:needle$/m,
		"a nested match keeps its directory",
	);
	const read = await executeRepositoryTool(policy, "read", { path: join("src", "data.txt") });
	assert.equal(read.split("\n")[0], join("src", "data.txt"), "the read header is the relative path");
	const found = (await executeRepositoryTool(policy, "find", { path: "." })).split("\n");
	assert.ok(found.includes(join("src", "data.txt")), "find reports nested paths, not basenames");
	assert.ok(found.includes("src"));
});

test("the root is canonical however it was spelled on the way in", async () => {
	const { root, policy } = await fixture();
	assert.equal(policy.root, await realpath(root), "createResolvedPathPolicy normalizes once, at construction");
	// The tools compare against exactly this string, so there is no second
	// spelling left for them to disagree with (P6).
	const allowed = await resolveAllowedPath(policy, join("src", "data.txt"));
	assert.ok(allowed.path?.startsWith(policy.root), "resolved paths sit under the stored root");
});
