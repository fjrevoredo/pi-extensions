import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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
export const PROTECTED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks"];

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
