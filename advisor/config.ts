import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { ADVISOR_VERSION, defaultConfig, DEFAULT_LIMITS, type AdvisorConfig, THINKING_LEVELS } from "./contracts.ts";
import { MODEL_REFERENCE_PATTERN } from "./model-reference.ts";

export const ADVISOR_CONFIG_FILENAME = "advisor.json";

/**
 * The advisor configuration lives beside pi's own agent state. The agent
 * directory is passed in rather than read here, so this module never imports
 * from `@earendil-works/*` (S2) and the tests never touch `~/.pi` (T7).
 */
export function advisorConfigPath(agentDirectory: string): string {
	return join(agentDirectory, ADVISOR_CONFIG_FILENAME);
}

function isPositiveInteger(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function hasOnlyKeys(value: object, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

export function validateConfig(value: unknown): AdvisorConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (!hasOnlyKeys(value, ["version", "enabled", "model", "thinking", "limits", "security"])) return undefined;
	const input = value as Partial<AdvisorConfig>;
	if (input.version !== ADVISOR_VERSION || typeof input.enabled !== "boolean") return undefined;
	if (input.model !== undefined && (typeof input.model !== "string" || !MODEL_REFERENCE_PATTERN.test(input.model))) return undefined;
	if (!THINKING_LEVELS.includes(input.thinking as AdvisorConfig["thinking"])) return undefined;
	const limits = input.limits;
	if (!limits || typeof limits !== "object" || Array.isArray(limits) || !hasOnlyKeys(limits, Object.keys(DEFAULT_LIMITS))) return undefined;
	const caps: Array<[keyof typeof DEFAULT_LIMITS, number, number]> = [
		["maxConsultationsPerRun", 1, 10], ["maxConsultationsPerSession", 1, 100], ["maxAdvisorTurns", 1, 20],
		["maxReadOnlyToolCalls", 1, 50], ["maxContextBytes", 4_096, 500_000], ["maxAdvisorOutputTokens", 256, 16_000], ["timeoutMs", 5_000, 600_000],
	];
	for (const [key, min, max] of caps) if (!isPositiveInteger(limits[key], min, max)) return undefined;
	if (limits.maxConsultationsPerRun > limits.maxConsultationsPerSession) return undefined;
	const security = input.security;
	if (!security || typeof security !== "object" || Array.isArray(security) || !hasOnlyKeys(security, ["redactKnownSecrets", "additionalProtectedPaths"]) || typeof security.redactKnownSecrets !== "boolean" || !Array.isArray(security.additionalProtectedPaths)) return undefined;
	if (security.additionalProtectedPaths.some((path) => typeof path !== "string" || !path.trim() || path.length > 240 || isAbsolute(path) || normalize(path).split(sep).includes(".."))) return undefined;
	return {
		version: ADVISOR_VERSION, enabled: input.enabled, ...(input.model ? { model: input.model } : {}), thinking: input.thinking as AdvisorConfig["thinking"],
		limits: { ...limits }, security: { redactKnownSecrets: security.redactKnownSecrets, additionalProtectedPaths: [...security.additionalProtectedPaths] },
	};
}

export async function loadConfig(path: string): Promise<{ config?: AdvisorConfig; error?: string }> {
	try {
		const text = await readFile(path, "utf8");
		const config = validateConfig(JSON.parse(text));
		return config ? { config } : { error: "Advisor configuration is invalid." };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig() };
		return { error: "Advisor configuration cannot be read." };
	}
}

export async function saveConfig(config: AdvisorConfig, path: string): Promise<void> {
	if (!validateConfig(config)) throw new Error("Invalid advisor configuration.");
	const directory = dirname(path);
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw new Error("Advisor configuration cannot be saved.", { cause: error });
	}
}

export function formatConfig(config: AdvisorConfig): string {
	return [
		`enabled: ${config.enabled}`, `model: ${config.model ?? "not configured"}`, `thinking: ${config.thinking}`,
		`limits: ${config.limits.maxConsultationsPerRun}/run, ${config.limits.maxConsultationsPerSession}/session, ${config.limits.maxAdvisorTurns} turns, ${config.limits.maxReadOnlyToolCalls} reads`,
		`redaction: ${config.security.redactKnownSecrets ? "on" : "off"}`,
	].join("\n");
}
