import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { bounded, boundedOutput, MAX_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from "./outbound-text.ts";
import type { PathPolicy } from "./path-policy.ts";
import { resolveAllowedPath } from "./path-access.ts";
import { displayPath } from "./path-policy.ts";

/**
 * The four read-only tools the advisor may reach: `read`, `grep`, `find`, `ls`.
 *
 * This is the shell that turns an admitted path into text. It owns no policy —
 * which paths are permitted is path-policy.ts, what survives on the way out is
 * outbound-text.ts — and every path it touches has been through
 * `resolveAllowedPath` first, including each entry discovered while walking. That
 * matters: a directory listing is not a licence to read what is inside it, so the
 * walk re-asks for every child rather than trusting its parent.
 *
 * A refusal is returned as a normal result prefixed `Denied:`, not thrown. The
 * advisor is being told something it can act on, and every tool routes through the
 * same wording so a refusal never reveals which of the two reasons applied.
 *
 * `read` refuses directories, images and anything containing a NUL byte. The last
 * is a cheap binary check rather than content sniffing: shipping a binary to the
 * provider costs tokens and tells the advisor nothing.
 */
const MAX_ENTRIES = 200;
const MAX_DEPTH = 6;

/**
 * A noise filter, **not** policy — that is path-policy.ts's job, and `.git`
 * appears in both lists independently. The distinction matters: this stays
 * case-sensitive **intentionally**, because a mixed-case miss here costs a little
 * wasted output rather than admitting anything. Nothing may rely on this to deny
 * a path.
 */
const EXCLUDED = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache"]);
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);

async function readBounded(path: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const info = await stat(path);
	if (!info.isFile()) throw new Error("Target is not a regular file.");
	if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("Images are not available to the advisor.");
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(info.size, MAX_OUTPUT_BYTES + 1));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		signal?.throwIfAborted();
		const contents = buffer.subarray(0, bytesRead);
		if (contents.includes(0)) throw new Error("Binary files are not available to the advisor.");
		return contents.toString("utf8");
	} finally { await handle.close(); }
}

async function walk(policy: PathPolicy, start: string, maxDepth: number, signal?: AbortSignal): Promise<string[]> {
	const output: string[] = [];
	// policy.root is canonical by construction (createResolvedPathPolicy), so the
	// relative paths below line up with the ones displayPath produces (P6).
	const root = policy.root;
	async function visit(directory: string, depth: number): Promise<void> {
		signal?.throwIfAborted();
		if (depth > maxDepth || output.length >= MAX_ENTRIES) return;
		let entries: Dirent[]; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (output.length >= MAX_ENTRIES || EXCLUDED.has(entry.name)) continue;
			const requested = relative(root, join(directory, entry.name));
			const allowed = await resolveAllowedPath(policy, requested);
			if (!allowed.path) continue;
			output.push(allowed.path);
			if (entry.isDirectory()) await visit(allowed.path, depth + 1);
		}
	}
	await visit(start, 0);
	return output;
}

export async function executeRepositoryTool(
	policy: PathPolicy,
	name: "read" | "grep" | "find" | "ls",
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const requested = typeof args.path === "string" ? args.path : ".";
	const allowed = await resolveAllowedPath(policy, requested);
	if (!allowed.path) return `Denied: ${allowed.error}`;
	if (name === "read") {
		const text = await readBounded(allowed.path, signal);
		const result = bounded(text, policy.redactKnownSecrets);
		const header = `${displayPath(policy.root, allowed.path)}${result.truncated ? " (truncated)" : ""}`;
		return `${header}\n${result.text}${result.truncated ? `\n${OUTPUT_TRUNCATION_NOTICE}` : ""}`;
	}
	if (name === "ls") {
		const info = await stat(allowed.path);
		if (!info.isDirectory()) return "Error: target is not a directory.";
		const entries = await readdir(allowed.path, { withFileTypes: true });
		const root = policy.root;
		const values: string[] = [];
		for (const entry of entries) {
			if (values.length >= MAX_ENTRIES || EXCLUDED.has(entry.name)) continue;
			const child = await resolveAllowedPath(policy, relative(root, join(allowed.path, entry.name)));
			if (child.path) values.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
		}
		return boundedOutput(values.join("\n"), policy.redactKnownSecrets);
	}
	const files = await walk(policy, allowed.path, typeof args.maxDepth === "number" ? Math.min(MAX_DEPTH, Math.max(0, args.maxDepth)) : MAX_DEPTH, signal);
	if (name === "find") return boundedOutput(files.map((path) => displayPath(policy.root, path)).join("\n"), policy.redactKnownSecrets);
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	if (!pattern || pattern.length > 200) return "Error: grep requires a short text pattern.";
	let expression: RegExp; try { expression = new RegExp(pattern, "i"); } catch { return "Error: grep pattern is invalid."; }
	const matches: string[] = [];
	for (const file of files) {
		if (matches.length >= MAX_ENTRIES) break;
		try {
			const contents = await readBounded(file, signal);
			for (const [index, line] of contents.split("\n").entries()) {
				if (expression.test(line)) matches.push(`${displayPath(policy.root, file)}:${index + 1}:${line}`);
				if (matches.length >= MAX_ENTRIES) break;
			}
		} catch { /* unreadable files are intentionally skipped */ }
	}
	return boundedOutput(matches.join("\n"), policy.redactKnownSecrets);
}
