import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Which files the advisor may open, decided from the path alone.
 *
 * **Security posture: this is risk reduction. It is not a security sandbox.** The
 * README says the same sentence, and so does the provider disclosure the user
 * confirms, because it is the honest description of what this can do. What it
 * buys is that an obvious mistake — the advisor asking for `.env`, or walking out
 * of the repository — is refused before any bytes are read. What it cannot do is
 * stop a determined attempt by something already running as this user.
 *
 * The reason it matters at all: whatever this admits is sent to a **third-party
 * provider**. Every other extension in this repository can at worst affect the
 * local machine. Widening this catalogue widens what leaves it.
 *
 * Pure by construction — `node:path` and nothing else, so the whole catalogue is
 * testable without a temporary directory (S1, T7). Everything that has to touch
 * the filesystem lives in path-access.ts, which is a deliberately small surface.
 *
 * Matching is **per path segment**, not per substring, and that distinction is
 * the whole design:
 *
 * - `.git` protects the directory `.git` and everything under it. It does **not**
 *   match `.gitignore` or `.gitattributes`, which are ordinary tracked files the
 *   advisor has every reason to read.
 * - A protected segment anywhere in the path denies the whole path, so
 *   `src/.git/config` and `packages/a/.npmrc` are both refused.
 * - The suffix list is checked against the last segment only, so `key.pem` is
 *   refused and `key.pem.txt` is not — the extension has to be final.
 */

/**
 * Exact segment names that are never read. Each entry is here for a reason, and
 * the reason is what a future reader needs in order to judge an addition:
 *
 * - `.git` — object store and config; `.git/config` can carry credentials in
 *   remote URLs, and the object store can carry deleted secrets that are no
 *   longer in the working tree.
 * - `.env` — the conventional home of local secrets. The `.env.<name>` family is
 *   matched by prefix rather than listed, so `.env.local` and
 *   `.env.production.local` are covered without enumerating them.
 * - `.ssh` — private keys and `known_hosts`.
 * - `.gnupg` — GPG private keyrings.
 * - `.aws`, `.azure`, `.kube` — cloud credential and cluster-access directories.
 *   Reading any of them would hand the provider live infrastructure access.
 * - `auth.json` — pi's own credential file, and the same name npm and several
 *   other tools use.
 * - `credentials.json` — Google service-account keys, and a common hand-rolled
 *   spelling.
 * - `.npmrc` — registry auth tokens.
 *
 * Every entry is lowercase, and `isProtected` folds case on both sides, so a
 * mixed-case addition here still works. See the note on that function.
 */
export const DEFAULT_PROTECTED = [
	".git",
	".env",
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	"auth.json",
	"credentials.json",
	".npmrc",
];

/**
 * Final extensions that are never read: private keys and keystores, whatever
 * they are called. A name-based list cannot anticipate `deploy-key.pem` or
 * `client-cert.p12`, so the extension carries the policy instead.
 */
export const PROTECTED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks"];

/**
 * What this policy **intentionally** does not cover. Each of these is a decision,
 * not an oversight, and is listed so a future reader treats it as one (D4).
 * Several are asserted as negative rows in test/path-policy.test.ts, so removing
 * one is a visible behaviour change rather than a silent widening.
 *
 * - `.envrc` is **intentionally** not matched. It is direnv's shell config, which
 *   usually contains `dotenv` directives and PATH edits rather than secrets, and
 *   matching every `.env`-prefixed name would sweep it in.
 * - `credentials.yaml` and other spellings are **intentionally** not matched.
 *   Only the `.json` spelling is catalogued; add spellings deliberately rather
 *   than guessing at a pattern.
 * - A private key outside `.ssh` — `id_rsa` in a project directory — is
 *   **intentionally** matched only if its extension is in the suffix list.
 *   Detection is by name, never by content.
 * - Hard links are **intentionally** not followed. `realpath` resolves symlinks;
 *   a hard link is a second name for the same inode with no link to follow, so a
 *   hard link to `.env` inside the repository is readable.
 * - Same-user TOCTOU is **intentionally** out of scope. The check and the read
 *   are separate syscalls, so anything able to swap a path between them is
 *   already running as this user and does not need the advisor's help.
 * - Content-based secret detection is **intentionally** not attempted here.
 *   Redaction in outbound-text.ts is the second, independent layer; this one is
 *   purely about paths.
 * - `EXCLUDED` in repository-tools.ts stays case-sensitive **intentionally**. It
 *   is a noise filter for `node_modules` and `dist`, not policy, so a
 *   mixed-case miss costs a little output rather than a leak.
 */

/**
 * The exact strings the advisor sees. They are part of the tool contract it
 * reads, so they are constants rather than literals at three call sites (T6).
 */
export const OUTSIDE_ROOT_ERROR = "Path is outside the advisor root.";
export const PROTECTED_OR_OUTSIDE_ERROR = "Path is protected or outside the advisor root.";
export const INACCESSIBLE_ERROR = "Path cannot be accessed.";

export interface PathPolicy {
	root: string;
	additionalProtectedPaths: string[];
	redactKnownSecrets: boolean;
}

export interface PathPolicyOptions {
	root: string;
	/** pi's agent directory, injected rather than read, so the policy is pure and testable (S2, S6). */
	agentDirectory: string;
	additionalProtectedPaths: string[];
	redactKnownSecrets?: boolean;
}

export function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * Matching is case-insensitive because the filesystems this runs on are. macOS
 * and Windows both resolve `Credentials.json` and `credentials.json` to the same
 * file, so comparing segments case-sensitively against a lowercase catalogue let
 * a real file with capitals through — and made a mixed-case
 * `additionalProtectedPaths` entry protect nothing at all, which is worse than
 * useless because it looks configured.
 *
 * Folding case can only ever widen denial, never narrow it: the catalogue is
 * lowercase, so every segment that matched before still matches. The catalogue
 * and the configured additions are folded too, so an entry added in mixed case
 * cannot silently stop working.
 *
 * This is fixed here rather than by canonicalizing the requested path's case.
 * `realpath.native` would do that, and it was rejected deliberately: it would
 * rewrite the casing of every path the advisor is shown, so results would stop
 * matching what the driver and the user see. The filter should be
 * case-insensitive; the output should not be case-normalized.
 */
export function isProtected(root: string, target: string, additions: string[]): boolean {
	const rel = relative(root, target).split(sep).filter(Boolean);
	if (rel.length === 0) return false;
	const configured = new Set([
		...DEFAULT_PROTECTED.map((value) => value.toLowerCase()),
		...additions.map((value) => value.replaceAll("\\", "/").split("/")[0].toLowerCase()),
	]);
	return rel.some((segment) => {
		const part = segment.toLowerCase();
		return (
			part === ".env" ||
			part.startsWith(".env.") ||
			configured.has(part) ||
			PROTECTED_SUFFIXES.some((suffix) => part.endsWith(suffix))
		);
	});
}

/**
 * The whole admission decision, as a value. Both the pre- and post-canonical
 * checks in `resolveAllowedPath` are this same question asked twice, which is
 * why it is one function rather than an inlined pair of conditions.
 */
export function admits(policy: PathPolicy, root: string, candidate: string): { ok: true } | { ok: false; error: string } {
	if (!isWithin(root, candidate) || isProtected(root, candidate, policy.additionalProtectedPaths)) {
		return { ok: false, error: PROTECTED_OR_OUTSIDE_ERROR };
	}
	return { ok: true };
}

/**
 * **The root and the agent directory must already be canonical.** This function
 * is pure, so it cannot canonicalize them itself — it only `resolve`s, which
 * normalizes `.` and `..` but does not follow symlinks. Use
 * `createResolvedPathPolicy` from path-access.ts unless you are constructing a
 * policy for a hermetic test over paths that never touch a disk.
 *
 * That distinction is the whole of the bug A10 fixed: `resolve` and `realpath`
 * are two different normalizers, and using one here while consumers used the
 * other left them comparing different spellings of the same directory (P6).
 */
export function createPathPolicy(options: PathPolicyOptions): PathPolicy {
	const additions = [...options.additionalProtectedPaths];
	if (isWithin(options.root, options.agentDirectory)) additions.push(relative(options.root, options.agentDirectory));
	return {
		root: resolve(options.root),
		additionalProtectedPaths: additions,
		redactKnownSecrets: options.redactKnownSecrets ?? true,
	};
}

/**
 * How one path is named in advisor-visible output: relative to the root.
 *
 * The basename fallback is a backstop for a path that somehow escapes the root,
 * so an absolute location never reaches the advisor. It is *only* a backstop —
 * before A10 a non-canonical root made it the normal path, which quietly reduced
 * every read header, find entry and grep hit to a filename with no directory.
 */
export function displayPath(root: string, path: string): string {
	const result = relative(root, path) || ".";
	return result.startsWith("..") ? basename(path) : result;
}
