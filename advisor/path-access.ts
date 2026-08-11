import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	admits,
	createPathPolicy,
	INACCESSIBLE_ERROR,
	OUTSIDE_ROOT_ERROR,
	type PathPolicy,
	type PathPolicyOptions,
} from "./path-policy.ts";

/**
 * The only part of the path filter that touches the filesystem.
 *
 * **Security posture: this is risk reduction. It is not a security sandbox** —
 * see path-policy.ts for what that means and what is intentionally not covered.
 * This module's narrower job is to make sure the policy is asked about the path
 * that will actually be opened, not the one that was typed.
 *
 * Splitting it out leaves path-policy.ts hermetic (node:path only), so the whole
 * catalogue is testable without a temporary directory (S1, T7). Keeping this
 * surface small is deliberate: it is the only place where what is on disk can
 * disagree with what the policy was told.
 *
 * The admission question is asked **twice**, and both halves are load-bearing.
 * Once on the resolved path, and again on the canonical path after symlinks are
 * followed. Checking only the first admits `link -> /etc`; checking only the
 * second would not reject a traversal that never resolves, because realpath fails
 * on a path that does not exist and the ENOENT branch admits it.
 */

/**
 * Canonicalize one path, falling back to `resolve` when it does not exist yet.
 *
 * **`realpath` comes from `node:fs/promises` and not from `node:fs`, and the
 * choice is load-bearing.** Measured on this platform: given `Credentials.json`
 * on disk and a request for `credentials.json`, `fs/promises.realpath` returns
 * the on-disk spelling `Credentials.json` while `fs.realpathSync` echoes the
 * requested `credentials.json` back. So the promises API folds filename case and
 * the synchronous one does not.
 *
 * Before A9 that difference was the *only* thing closing the requested-casing
 * hole: `isProtected` compared case-sensitively, so a request for `.ENV` was
 * refused solely because realpath had already rewritten it to `.env`. That was an
 * undocumented accident holding up a security property. A9 fixed the comparison
 * itself, so this is now the second of two independent layers rather than the
 * only one — but swapping the import would still silently change every path the
 * advisor is shown, and would reopen the hole on any platform or Node version
 * where the folding differs. Do not swap it for the synchronous form.
 */
async function canonicalize(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

/**
 * Build a policy whose root is already canonical.
 *
 * This is the constructor callers should use. `createPathPolicy` is pure and so
 * cannot canonicalize anything itself, which is exactly how the two spellings of
 * the root drifted apart: it stored `resolve(root)` while every consumer
 * separately computed `realpath(root)`. P6 wants one normalizer, applied once,
 * and shared — so it is applied here, at construction, rather than trusted to
 * each call site. Both paths the policy is built from go through it, since the
 * `isWithin(root, agentDirectory)` guard compares them to each other.
 */
export async function createResolvedPathPolicy(options: PathPolicyOptions): Promise<PathPolicy> {
	const [root, agentDirectory] = await Promise.all([canonicalize(options.root), canonicalize(options.agentDirectory)]);
	return createPathPolicy({ ...options, root, agentDirectory });
}

export async function resolveAllowedPath(
	policy: PathPolicy,
	requested: string,
): Promise<{ path?: string; error?: string }> {
	if (!requested || typeof requested !== "string" || isAbsolute(requested)) return { error: OUTSIDE_ROOT_ERROR };
	// The root is canonical already, by construction. Re-deriving it here is what
	// let it disagree with the copy stored on the policy (P6).
	const root = policy.root;
	const candidate = resolve(root, requested);
	const resolved = admits(policy, root, candidate);
	if (!resolved.ok) return { error: resolved.error };
	try {
		const canonical = await realpath(candidate);
		const followed = admits(policy, root, canonical);
		if (!followed.ok) return { error: followed.error };
		return { path: canonical };
	} catch (error) {
		// ENOENT is admitted deliberately: the advisor may reference a path that
		// does not exist yet, and the pre-canonical check above already passed.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: candidate };
		return { error: INACCESSIBLE_ERROR };
	}
}
