import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	admits,
	INACCESSIBLE_ERROR,
	OUTSIDE_ROOT_ERROR,
	type PathPolicy,
} from "./path-policy.ts";

/**
 * The only part of the path filter that touches the filesystem. Splitting it out
 * leaves path-policy.ts hermetic (node:path only), so the policy table can be
 * tested without a temporary directory (S1, T7).
 *
 * The admission question is asked twice on purpose: once on the resolved path,
 * and again on the canonical path after symlinks are followed. Checking only the
 * first admits `link -> /etc`; checking only the second would not reject a
 * traversal that never resolves.
 */
export async function resolveAllowedPath(policy: PathPolicy, requested: string): Promise<{ path?: string; error?: string }> {
	if (!requested || typeof requested !== "string" || isAbsolute(requested)) return { error: OUTSIDE_ROOT_ERROR };
	const root = await realpath(policy.root).catch(() => resolve(policy.root));
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
