import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_OUTPUT_LINES, OUTPUT_TRUNCATION_NOTICE } from "../outbound-text.ts";
import { createPathPolicy, PROTECTED_OR_OUTSIDE_ERROR } from "../path-policy.ts";
import { executeRepositoryTool } from "../repository-tools.ts";

/**
 * The four tools the advisor may reach. The read and grep cases here were
 * previously in path-policy.test.ts, which is not where a reader looks for them
 * (L5).
 *
 * Injected rather than read from pi, so these tests never touch ~/.pi (T7).
 */
const agentDirectory = join(tmpdir(), "advisor-tests-agent-dir");

async function fixture(options: { redact?: boolean; canonicalRoot?: boolean } = {}) {
	const created = await mkdtemp(join(tmpdir(), "advisor-tools-"));
	const root = options.canonicalRoot ? await realpath(created) : created;
	await mkdir(join(root, "src"));
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "node_modules", "junk.txt"), "needle");
	await writeFile(join(root, "src", "data.txt"), "token=sk_abcdefghijklmnop\nneedle\n");
	await writeFile(join(root, "top.txt"), "needle at the top\n");
	await writeFile(join(root, ".env"), "needle in a protected file\n");
	await writeFile(join(root, "logo.png"), "not really a png");
	await writeFile(join(root, "blob.bin"), Buffer.from([0x68, 0x00, 0x69]));
	const policy = createPathPolicy({
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

test("results are relative to the root when the root is canonical", async () => {
	const { policy } = await fixture({ canonicalRoot: true });
	assert.match(
		await executeRepositoryTool(policy, "grep", { path: ".", pattern: "needle" }),
		/^src[/\\]data\.txt:2:needle$/m,
		"a nested match keeps its directory",
	);
	const read = await executeRepositoryTool(policy, "read", { path: join("src", "data.txt") });
	assert.equal(read.split("\n")[0], join("src", "data.txt"), "the read header is the relative path");
});

test("DEFECT (A10): a non-canonical root reduces every result to a bare filename", async () => {
	const { root, policy } = await fixture();
	const canonical = await realpath(root);
	if (root === canonical) return; // nothing to pin on a filesystem without the symlink

	// createPathPolicy stores resolve(root) while every consumer computes
	// realpath(root) separately, so relative() escapes upward and displayPath
	// takes its basename fallback. The directory is silently dropped from every
	// read header, find entry and grep hit — and this is the *normal* case on
	// macOS, not an edge case.
	//
	// The lesson the plan draws from this is why the assertions above exist: the
	// old suite asserted /data\.txt:2:needle/, which passes through this fallback
	// just as happily as through the intended path, so the intended path had
	// never executed. A10 flips these two assertions.
	const grep = await executeRepositoryTool(policy, "grep", { path: ".", pattern: "needle" });
	assert.match(grep, /^data\.txt:2:needle$/m, "A10 flips this to src/data.txt:2:needle");
	const read = await executeRepositoryTool(policy, "read", { path: join("src", "data.txt") });
	assert.equal(read.split("\n")[0], "data.txt", "A10 flips this to src/data.txt");
});
