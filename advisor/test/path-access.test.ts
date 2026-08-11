import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResolvedPathPolicy, resolveAllowedPath } from "../path-access.ts";
import {
	createPathPolicy,
	INACCESSIBLE_ERROR,
	OUTSIDE_ROOT_ERROR,
	PROTECTED_OR_OUTSIDE_ERROR,
} from "../path-policy.ts";

/**
 * The filesystem half of the path filter. Everything that can be decided from a
 * string is in path-policy.test.ts; what is left needs real symlinks, real
 * missing files, and a real non-canonical root.
 *
 * Injected rather than read from pi, so these tests never touch ~/.pi (T7).
 */
const agentDirectory = join(tmpdir(), "advisor-tests-agent-dir");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "advisor-access-"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "safe.txt"), "hello");
	await writeFile(join(root, ".env"), "NOPE");
	await writeFile(join(root, ".env.local"), "NOPE");
	await writeFile(join(root, "notadir.txt"), "x");
	await mkdir(join(root, "private"));
	await writeFile(join(root, "private", "notes.md"), "NOPE");
	await writeFile(join(root, "Credentials.json"), "NOPE");
	await writeFile(join(root, "Auth.JSON"), "NOPE");
	await mkdir(join(root, "Secrets"));
	await writeFile(join(root, "Secrets", "notes.md"), "NOPE");
	await symlink("/etc", join(root, "escape"));
	await symlink(join(root, "src", "safe.txt"), join(root, "inside-link.txt"));
	await symlink(join(root, ".env"), join(root, "env-link"));
	const policy = await createResolvedPathPolicy({ root, agentDirectory, additionalProtectedPaths: ["private"] });
	return { root, policy };
}

test("admits a permitted file and returns its canonical path", async () => {
	const { root, policy } = await fixture();
	const result = await resolveAllowedPath(policy, join("src", "safe.txt"));
	assert.equal(result.error, undefined);
	assert.equal(result.path, join(await realpath(root), "src", "safe.txt"), "the returned path is canonical");
});

test("rejects an absolute path and an empty path before touching the disk (T6)", async () => {
	const { policy } = await fixture();
	// A different message from the protected case on purpose: an absolute path is
	// a malformed request, not a permission decision, so saying so reveals nothing.
	assert.deepEqual(await resolveAllowedPath(policy, "/etc/passwd"), { error: OUTSIDE_ROOT_ERROR });
	assert.deepEqual(await resolveAllowedPath(policy, ""), { error: OUTSIDE_ROOT_ERROR });
});

test("rejects traversal, protected names, and configured additions (T6)", async () => {
	const { policy } = await fixture();
	for (const requested of [
		join("..", "etc", "passwd"),
		join("src", "..", "..", "etc", "passwd"),
		".env",
		".env.local",
		join("private", "notes.md"),
	]) {
		assert.deepEqual(
			await resolveAllowedPath(policy, requested),
			{ error: PROTECTED_OR_OUTSIDE_ERROR },
			`${requested} should be denied`,
		);
	}
});

test("denies a file that is genuinely named with capitals on disk (P6)", async () => {
	const { root, policy } = await fixture();
	// These exist under exactly these names — realpath returns the capitals, so
	// there is no canonicalization to lean on and the filter itself has to fold
	// case. Before A9 both were admitted and read.
	for (const requested of ["Credentials.json", "Auth.JSON"]) {
		assert.deepEqual(
			await resolveAllowedPath(policy, requested),
			{ error: PROTECTED_OR_OUTSIDE_ERROR },
			`${requested} should be denied`,
		);
	}
	// Nothing in the catalogue mentions "Secrets", so this policy reads it — the
	// fix folds case, it does not add names.
	assert.ok((await resolveAllowedPath(policy, join("Secrets", "notes.md"))).path);
	// Configure it in any casing and the on-disk directory is protected in any
	// casing. Before A9 this pairing silently protected nothing.
	for (const configuredAs of ["Secrets", "SECRETS", "secrets", "SeCrEtS"]) {
		const configured = await createResolvedPathPolicy({
			root,
			agentDirectory,
			additionalProtectedPaths: [configuredAs],
		});
		assert.deepEqual(
			await resolveAllowedPath(configured, join("Secrets", "notes.md")),
			{ error: PROTECTED_OR_OUTSIDE_ERROR },
			`additionalProtectedPaths: ["${configuredAs}"] should protect the on-disk Secrets/`,
		);
	}
	// And folding did not make the filter fuzzy: an ordinary file is still read.
	assert.ok((await resolveAllowedPath(policy, join("src", "safe.txt"))).path);
});

test("follows symlinks before deciding, so a link out of the root is rejected", async () => {
	const { policy } = await fixture();
	// The pre-canonical check passes for both of these — "escape/passwd" and
	// "env-link" are inside the root as written. Only the post-realpath check
	// catches them, which is why the admission question is asked twice.
	assert.deepEqual(await resolveAllowedPath(policy, join("escape", "passwd")), { error: PROTECTED_OR_OUTSIDE_ERROR });
	assert.deepEqual(await resolveAllowedPath(policy, "env-link"), {
		error: PROTECTED_OR_OUTSIDE_ERROR,
	});
});

test("admits a symlink that stays inside the root, resolved to its target", async () => {
	const { root, policy } = await fixture();
	const result = await resolveAllowedPath(policy, "inside-link.txt");
	assert.equal(result.path, join(await realpath(root), "src", "safe.txt"));
});

test("admits a path that does not exist yet, but not one that only looks accessible", async () => {
	const { root, policy } = await fixture();
	// ENOENT is deliberately admitted: the advisor may name a file it expects to
	// exist, and the pre-canonical check has already passed. The caller gets the
	// resolved candidate and fails on open, which is the honest error.
	const missing = await resolveAllowedPath(policy, join("src", "nope.txt"));
	assert.equal(missing.error, undefined);
	assert.equal(missing.path, join(await realpath(root), "src", "nope.txt"));

	// A protected name that does not exist is still refused — the policy check
	// runs before realpath, so absence cannot be used to probe around it.
	assert.deepEqual(await resolveAllowedPath(policy, join(".ssh", "id_rsa")), { error: PROTECTED_OR_OUTSIDE_ERROR });

	// Anything other than ENOENT denies. Treating a file as a directory gives
	// ENOTDIR, which must not be mistaken for "not there yet".
	assert.deepEqual(await resolveAllowedPath(policy, join("notadir.txt", "child")), { error: INACCESSIBLE_ERROR });
});

test("stores one canonical root, whatever spelling it was given (P6)", async () => {
	// mkdtemp under /var/folders is reached through a symlink on macOS, so a
	// non-canonical root is the normal case here, not a contrived one. A8 pinned
	// policy.root as the symlinked spelling; A10 canonicalizes it at construction
	// so there is only ever one spelling to compare against.
	const { root, policy } = await fixture();
	const canonical = await realpath(root);
	assert.equal(policy.root, canonical, "one normalizer, applied once");
	const result = await resolveAllowedPath(policy, join("src", "safe.txt"));
	assert.equal(result.path, join(canonical, "src", "safe.txt"));
	assert.deepEqual(await resolveAllowedPath(policy, ".env"), { error: PROTECTED_OR_OUTSIDE_ERROR });
});

test("protects the agent directory when it sits inside a symlinked root", async () => {
	// The guard this exercises did not work before A10. It compares the root with
	// the agent directory, and the root was stored in a different spelling than
	// the one relative() needed, so an agent directory genuinely inside the repo
	// was judged outside it and left unprotected.
	const root = await mkdtemp(join(tmpdir(), "advisor-agentdir-"));
	await mkdir(join(root, ".pi", "agent"), { recursive: true });
	await writeFile(join(root, ".pi", "agent", "sessions.json"), "NOPE");
	const policy = await createResolvedPathPolicy({
		root,
		agentDirectory: join(root, ".pi", "agent"),
		additionalProtectedPaths: [],
	});
	assert.ok(policy.additionalProtectedPaths.includes(join(".pi", "agent")), "the guard matched");
	assert.deepEqual(await resolveAllowedPath(policy, join(".pi", "agent", "sessions.json")), {
		error: PROTECTED_OR_OUTSIDE_ERROR,
	});
	// Reduced to its first segment, so the whole .pi tree is covered, not just the
	// agent directory the guard happened to name.
	assert.deepEqual(await resolveAllowedPath(policy, join(".pi", "anything-else")), {
		error: PROTECTED_OR_OUTSIDE_ERROR,
	});
});

test("a root that does not exist still applies the policy, and denies nothing extra", async () => {
	const policy = await createResolvedPathPolicy({
		root: join(tmpdir(), "advisor-root-that-does-not-exist"),
		agentDirectory,
		additionalProtectedPaths: [],
	});
	// realpath(root) fails, so the root falls back to resolve(root); the requested
	// path is then inside a directory that is not there, giving ENOENT and the
	// candidate path back. Nothing can be read from it, but the filter itself does
	// not treat a missing root as a reason to deny.
	const result = await resolveAllowedPath(policy, "a.txt");
	assert.equal(result.error, undefined);
	assert.equal(result.path, join(policy.root, "a.txt"));
	assert.deepEqual(await resolveAllowedPath(policy, ".env"), { error: PROTECTED_OR_OUTSIDE_ERROR });
});

test("the pure constructor's canonical-root contract fails closed when it is broken", async () => {
	// createPathPolicy only `resolve`s, so handing it a root reached through a
	// symlink leaves policy.root disagreeing with the canonical paths realpath
	// returns. Since A10, resolveAllowedPath trusts policy.root instead of
	// re-deriving it, which means that misuse denies everything rather than
	// admitting anything — the safe direction, and asserted here so it stays that
	// way. Before A10 the same misuse was admitted, because the root was
	// canonicalized again on every call.
	const created = await mkdtemp(join(tmpdir(), "advisor-contract-"));
	const canonical = await realpath(created);
	await mkdir(join(created, "src"));
	await writeFile(join(created, "src", "safe.txt"), "hello");

	if (created !== canonical) {
		const misused = createPathPolicy({ root: created, agentDirectory, additionalProtectedPaths: [] });
		assert.deepEqual(
			await resolveAllowedPath(misused, join("src", "safe.txt")),
			{ error: PROTECTED_OR_OUTSIDE_ERROR },
			"a non-canonical root must deny, never admit",
		);
	}

	// Honouring the contract — either constructor — admits normally.
	const honoured = createPathPolicy({ root: canonical, agentDirectory, additionalProtectedPaths: [] });
	assert.ok((await resolveAllowedPath(honoured, join("src", "safe.txt"))).path);
	const resolved = await createResolvedPathPolicy({ root: created, agentDirectory, additionalProtectedPaths: [] });
	assert.ok((await resolveAllowedPath(resolved, join("src", "safe.txt"))).path);
});
