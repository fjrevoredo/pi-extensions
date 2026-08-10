import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { PathPolicy } from "./path-policy.ts";
import { displayPath, resolveAllowedPath } from "./path-policy.ts";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;
const MAX_ENTRIES = 200;
const MAX_DEPTH = 6;
const EXCLUDED = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache"]);
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);

export function redactKnownSecrets(text: string): string {
	return text
		.replace(/(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED_SECRET]")
		.replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s'"`]+/gi, "$1[REDACTED_SECRET]");
}

function bounded(text: string, redact: boolean): { text: string; truncated: boolean } {
	let result = text;
	let truncated = false;
	if (Buffer.byteLength(result) > MAX_BYTES) {
		result = Buffer.from(result).subarray(0, MAX_BYTES).toString("utf8");
		truncated = true;
	}
	const lines = result.split("\n");
	if (lines.length > MAX_LINES) {
		result = lines.slice(0, MAX_LINES).join("\n");
		truncated = true;
	}
	return { text: redact ? redactKnownSecrets(result) : result, truncated };
}

function boundedOutput(text: string, redact: boolean): string {
	const result = bounded(text, redact);
	return result.truncated ? `${result.text}\n[Output truncated at ${MAX_LINES} lines or ${MAX_BYTES} bytes.]` : result.text;
}

async function readBounded(path: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const info = await stat(path);
	if (!info.isFile()) throw new Error("Target is not a regular file.");
	if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("Images are not available to the advisor.");
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES + 1));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		signal?.throwIfAborted();
		const contents = buffer.subarray(0, bytesRead);
		if (contents.includes(0)) throw new Error("Binary files are not available to the advisor.");
		return contents.toString("utf8");
	} finally { await handle.close(); }
}

async function walk(policy: PathPolicy, start: string, maxDepth: number, signal?: AbortSignal): Promise<string[]> {
	const output: string[] = [];
	const root = await realpath(policy.root).catch(() => policy.root);
	async function visit(directory: string, depth: number): Promise<void> {
		signal?.throwIfAborted();
		if (depth > maxDepth || output.length >= MAX_ENTRIES) return;
		let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
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
		return `${displayPath(policy.root, allowed.path)}${result.truncated ? " (truncated)" : ""}\n${result.text}${result.truncated ? `\n[Output truncated at ${MAX_LINES} lines or ${MAX_BYTES} bytes.]` : ""}`;
	}
	if (name === "ls") {
		const info = await stat(allowed.path);
		if (!info.isDirectory()) return "Error: target is not a directory.";
		const entries = await readdir(allowed.path, { withFileTypes: true });
		const root = await realpath(policy.root).catch(() => policy.root);
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
