import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	admits,
	createPathPolicy,
	DEFAULT_PROTECTED,
	displayPath,
	isProtected,
	isWithin,
	type PathPolicy,
	PROTECTED_OR_OUTSIDE_ERROR,
	PROTECTED_SUFFIXES,
} from "../path-policy.ts";

/**
 * Hermetic by construction: path-policy.ts imports `node:path` and nothing else,
 * so none of this needs a temporary directory (T7). Anything that has to touch
 * the filesystem is in path-access.test.ts.
 *
 * The catalogue is a security policy, so coverage of it is **counted** rather
 * than asserted in prose (P4): the last test in this file walks
 * DEFAULT_PROTECTED and PROTECTED_SUFFIXES and fails if any entry lacks both a
 * positive and a near-miss negative row. Adding a catalogue entry without a test
 * therefore breaks the build.
 */

const ROOT = "/repo";
const at = (...parts: string[]) => join(ROOT, ...parts);

interface Row {
	/** The path, relative to the root, as the advisor would ask for it. */
	path: string;
	expected: boolean;
	/** Which catalogue entry this row exercises. Drives the coverage count. */
	covers: string;
	additions?: string[];
	/** Why this row asserts something other than the intended policy. */
	defect?: string;
	/** Why this row asserts a deliberate gap rather than an oversight (D4). */
	intentional?: string;
}

const TABLE: Row[] = [
	// ---- .git: the directory, not everything that starts with it
	{ path: ".git", expected: true, covers: ".git" },
	{ path: ".git/config", expected: true, covers: ".git" },
	{ path: "src/.git/config", expected: true, covers: ".git" },
	{ path: ".gitignore", expected: false, covers: ".git" },
	{ path: ".gitattributes", expected: false, covers: ".git" },

	// ---- .env plus the `.env.<anything>` family, which is a separate branch
	{ path: ".env", expected: true, covers: ".env" },
	{ path: ".env.local", expected: true, covers: ".env" },
	{ path: ".env.production.local", expected: true, covers: ".env" },
	{ path: "config/.env", expected: true, covers: ".env" },
	{
		path: ".envrc",
		expected: false,
		covers: ".env",
		intentional: "direnv config is not matched; see A13's non-coverage list",
	},
	{ path: ".environment", expected: false, covers: ".env" },
	{ path: "env", expected: false, covers: ".env" },

	// ---- .ssh
	{ path: ".ssh", expected: true, covers: ".ssh" },
	{ path: "home/.ssh/id_rsa", expected: true, covers: ".ssh" },
	{ path: ".sshrc", expected: false, covers: ".ssh" },
	{
		path: "keys/id_rsa",
		expected: false,
		covers: ".ssh",
		intentional: "a private key outside .ssh is matched by name only, not by content",
	},

	// ---- .gnupg
	{ path: ".gnupg", expected: true, covers: ".gnupg" },
	{ path: ".gnupg/secring.gpg", expected: true, covers: ".gnupg" },
	{ path: ".gnupg.bak", expected: false, covers: ".gnupg" },

	// ---- cloud provider credential directories
	{ path: ".aws", expected: true, covers: ".aws" },
	{ path: ".aws/credentials", expected: true, covers: ".aws" },
	{ path: "aws", expected: false, covers: ".aws" },
	{ path: ".azure", expected: true, covers: ".azure" },
	{ path: ".azure/accessTokens.json", expected: true, covers: ".azure" },
	{ path: ".azurerc", expected: false, covers: ".azure" },
	{ path: ".kube", expected: true, covers: ".kube" },
	{ path: ".kube/config", expected: true, covers: ".kube" },
	{ path: ".kubeconfig", expected: false, covers: ".kube" },

	// ---- exact filenames
	{ path: "auth.json", expected: true, covers: "auth.json" },
	{ path: "nested/deep/auth.json", expected: true, covers: "auth.json" },
	{ path: "oauth.json", expected: false, covers: "auth.json" },
	{ path: "auth.json.bak", expected: false, covers: "auth.json" },
	{ path: "credentials.json", expected: true, covers: "credentials.json" },
	{
		path: "credentials.yaml",
		expected: false,
		covers: "credentials.json",
		intentional: "only the .json spelling is catalogued; see A13's non-coverage list",
	},
	{ path: ".npmrc", expected: true, covers: ".npmrc" },
	{ path: "packages/a/.npmrc", expected: true, covers: ".npmrc" },
	{ path: ".npmrc.bak", expected: false, covers: ".npmrc" },

	// ---- suffixes. The suffix branch lowercases the segment, so it is
	// case-insensitive even though the name branch above is not — that asymmetry
	// is the defect A9 removes, and KEY.PEM below is the half that already works.
	{ path: "key.pem", expected: true, covers: ".pem" },
	{ path: "certs/server.pem", expected: true, covers: ".pem" },
	{ path: "KEY.PEM", expected: true, covers: ".pem" },
	{ path: "key.pem.txt", expected: false, covers: ".pem" },
	{ path: "signing.key", expected: true, covers: ".key" },
	{ path: "signing.key.bak", expected: false, covers: ".key" },
	{ path: "api.keys", expected: false, covers: ".key" },
	{ path: "bundle.p12", expected: true, covers: ".p12" },
	{ path: "bundle.p12.bak", expected: false, covers: ".p12" },
	{ path: "bundle.pfx", expected: true, covers: ".pfx" },
	{ path: "bundle.pfx.old", expected: false, covers: ".pfx" },
	{ path: "store.jks", expected: true, covers: ".jks" },
	{ path: "store.jks.bak", expected: false, covers: ".jks" },

	// ---- the root itself is not protected, or nothing could ever be read
	{ path: "", expected: false, covers: "root" },

	// ---- additionalProtectedPaths
	{ path: "private/notes.md", expected: true, covers: "additions", additions: ["private"] },
	{ path: "public/notes.md", expected: false, covers: "additions", additions: ["private"] },

	// ---- DEFECT ROWS (A9). Each asserts today's wrong answer so the fix reads as
	// a behaviour diff. `isProtected` compares segments case-sensitively against a
	// lowercase catalogue, so a real file with capitals is admitted and read.
	{
		path: "Credentials.json",
		expected: false,
		covers: "case",
		defect: "A9 flips to true: a real Credentials.json is currently admitted",
	},
	{ path: ".ENV", expected: false, covers: "case", defect: "A9 flips to true" },
	{ path: ".Env.local", expected: false, covers: "case", defect: "A9 flips to true" },
	{ path: "AUTH.JSON", expected: false, covers: "case", defect: "A9 flips to true" },
	{ path: ".Git/config", expected: false, covers: "case", defect: "A9 flips to true" },
	{ path: ".SSH/id_rsa", expected: false, covers: "case", defect: "A9 flips to true" },
	{
		path: "secrets/notes.md",
		expected: false,
		covers: "case",
		additions: ["Secrets"],
		defect: "A9 flips to true: a mixed-case additionalProtectedPaths entry currently protects nothing",
	},
];

test("isProtected matches the catalogue per path segment, positives and near misses", () => {
	for (const row of TABLE) {
		const target = row.path ? at(row.path) : ROOT;
		const actual = isProtected(ROOT, target, row.additions ?? []);
		const why = row.defect
			? ` [pinned defect: ${row.defect}]`
			: row.intentional
				? ` [intentional: ${row.intentional}]`
				: "";
		assert.equal(actual, row.expected, `isProtected(${JSON.stringify(row.path)}) should be ${row.expected}${why}`);
	}
});

test("every catalogue entry has both a positive and a near-miss negative case (P4)", () => {
	const counted = [...DEFAULT_PROTECTED, ...PROTECTED_SUFFIXES];
	assert.equal(counted.length, 15, "catalogue size changed — add rows for the new entry");
	for (const entry of counted) {
		const rows = TABLE.filter((row) => row.covers === entry && !row.defect);
		assert.ok(rows.length > 0, `no table row covers ${entry}`);
		assert.ok(
			rows.some((row) => row.expected),
			`${entry} has no positive case`,
		);
		assert.ok(
			rows.some((row) => !row.expected),
			`${entry} has no near-miss negative case`,
		);
	}
});

test("additionalProtectedPaths is reduced to its first segment, and separators are normalized", () => {
	// A configured "a/b" protects every segment named "a", not the pair "a/b".
	// That widening is deliberate — it cannot admit more than the operator asked
	// for — but it is surprising enough to assert rather than leave implied.
	assert.equal(isProtected(ROOT, at("a", "b"), ["a/b"]), true);
	assert.equal(isProtected(ROOT, at("a", "unrelated"), ["a/b"]), true);
	assert.equal(isProtected(ROOT, at("x", "b"), ["a/b"]), false, "the second segment is not consulted");
	assert.equal(isProtected(ROOT, at("a", "b"), ["a\\b"]), true, "backslashes normalize to forward slashes");
	assert.equal(isProtected(ROOT, at("deep", "a", "file"), ["a/b"]), true, "matching is per segment at any depth");
});

test("isWithin accepts the root and its descendants and rejects siblings that share a prefix", () => {
	assert.equal(isWithin(ROOT, ROOT), true, "the root is within itself");
	assert.equal(isWithin(ROOT, at("src", "a.ts")), true);
	assert.equal(isWithin(ROOT, "/repo-2/a.ts"), false, "a sibling sharing the name prefix is outside");
	assert.equal(isWithin(ROOT, "/"), false);
	assert.equal(isWithin(ROOT, "/etc/passwd"), false);
	assert.equal(isWithin(ROOT, at("..")), false);
});

const policyFor = (additions: string[] = []): PathPolicy => ({
	root: ROOT,
	additionalProtectedPaths: additions,
	redactKnownSecrets: true,
});

test("admits reports the same message for protected and for outside-the-root (T6)", () => {
	assert.deepEqual(admits(policyFor(), ROOT, at("src", "a.ts")), { ok: true });
	// One message for two reasons, on purpose: telling the advisor which of the
	// two it hit would confirm whether a path it may not read exists.
	assert.deepEqual(admits(policyFor(), ROOT, at(".env")), { ok: false, error: PROTECTED_OR_OUTSIDE_ERROR });
	assert.deepEqual(admits(policyFor(), ROOT, "/etc/passwd"), { ok: false, error: PROTECTED_OR_OUTSIDE_ERROR });
	assert.deepEqual(admits(policyFor(["private"]), ROOT, at("private", "x")), {
		ok: false,
		error: PROTECTED_OR_OUTSIDE_ERROR,
	});
});

test("createPathPolicy protects the agent directory only when it sits inside the root", () => {
	const inside = createPathPolicy({
		root: ROOT,
		agentDirectory: at(".pi", "agent"),
		additionalProtectedPaths: ["private"],
	});
	assert.deepEqual(inside.additionalProtectedPaths, ["private", join(".pi", "agent")]);
	// The entry is reduced to its first segment, so the whole .pi tree is covered.
	assert.equal(isProtected(ROOT, at(".pi", "agent", "advisor.json"), inside.additionalProtectedPaths), true);
	assert.equal(isProtected(ROOT, at(".pi", "sessions", "x.json"), inside.additionalProtectedPaths), true);

	const outside = createPathPolicy({
		root: ROOT,
		agentDirectory: "/home/someone/.pi/agent",
		additionalProtectedPaths: ["private"],
	});
	assert.deepEqual(
		outside.additionalProtectedPaths,
		["private"],
		"an agent directory outside the root needs no entry",
	);
});

test("createPathPolicy defaults redaction on and normalizes the root", () => {
	const base = { root: `${ROOT}/./sub/..`, agentDirectory: "/elsewhere", additionalProtectedPaths: [] };
	assert.equal(createPathPolicy(base).redactKnownSecrets, true, "redaction is opt-out, not opt-in");
	assert.equal(createPathPolicy({ ...base, redactKnownSecrets: false }).redactKnownSecrets, false);
	// DEFECT (A10): the root is only `resolve`d, never `realpath`ed, so a root
	// reached through a symlink stays non-canonical while every consumer computes
	// realpath separately. The observable consequence is pinned in
	// repository-tools.test.ts; here we can only pin that resolve is all it does.
	assert.equal(createPathPolicy(base).root, ROOT);
});

test("displayPath falls back to a bare basename outside the root", () => {
	assert.equal(displayPath(ROOT, at("src", "a.ts")), join("src", "a.ts"));
	assert.equal(displayPath(ROOT, ROOT), ".", "the root renders as . rather than an empty string");
	// DEFECT (A10) in its most direct form. This fallback exists so a stray path
	// cannot leak an absolute location into advisor-visible output, but today it
	// is the *normal* path whenever the root is non-canonical, which silently
	// reduces every result to a filename.
	assert.equal(displayPath(ROOT, "/elsewhere/deep/a.ts"), "a.ts");
});
