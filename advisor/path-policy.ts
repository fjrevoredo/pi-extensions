import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_PROTECTED = [
	".git", ".env", ".ssh", ".gnupg", ".aws", ".azure", ".kube", "auth.json", "credentials.json", ".npmrc",
];
const PROTECTED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks"];

export interface PathPolicy {
	root: string;
	additionalProtectedPaths: string[];
	redactKnownSecrets: boolean;
}

export function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isProtected(root: string, target: string, additions: string[]): boolean {
	const rel = relative(root, target).split(sep).filter(Boolean);
	if (rel.length === 0) return false;
	const configured = new Set([...DEFAULT_PROTECTED, ...additions.map((value) => value.replaceAll("\\", "/").split("/")[0])]);
	return rel.some((part) => part === ".env" || part.startsWith(".env.") || configured.has(part) || PROTECTED_SUFFIXES.some((suffix) => part.toLowerCase().endsWith(suffix)));
}

export async function resolveAllowedPath(policy: PathPolicy, requested: string): Promise<{ path?: string; error?: string }> {
	if (!requested || typeof requested !== "string" || isAbsolute(requested)) return { error: "Path is outside the advisor root." };
	const root = await realpath(policy.root).catch(() => resolve(policy.root));
	const candidate = resolve(root, requested);
	if (!isWithin(root, candidate) || isProtected(root, candidate, policy.additionalProtectedPaths)) return { error: "Path is protected or outside the advisor root." };
	try {
		const canonical = await realpath(candidate);
		if (!isWithin(root, canonical) || isProtected(root, canonical, policy.additionalProtectedPaths)) return { error: "Path is protected or outside the advisor root." };
		return { path: canonical };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: candidate };
		return { error: "Path cannot be accessed." };
	}
}

export interface PathPolicyOptions {
	root: string;
	/** pi's agent directory, injected rather than read, so the policy is pure and testable (S2, S6). */
	agentDirectory: string;
	additionalProtectedPaths: string[];
	redactKnownSecrets?: boolean;
}

export function createPathPolicy(options: PathPolicyOptions): PathPolicy {
	const additions = [...options.additionalProtectedPaths];
	if (isWithin(options.root, options.agentDirectory)) additions.push(relative(options.root, options.agentDirectory));
	return {
		root: resolve(options.root),
		additionalProtectedPaths: additions,
		redactKnownSecrets: options.redactKnownSecrets ?? true,
	};
}

export function displayPath(root: string, path: string): string {
	const result = relative(root, path) || ".";
	return result.startsWith("..") ? basename(path) : result;
}
