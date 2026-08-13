import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ADVISOR_CONFIG_FILENAME,
	advisorConfigPath,
	formatConfig,
	loadConfig,
	saveConfig,
	validateConfig,
} from "../config.ts";
import { type AdvisorConfig, DEFAULT_LIMITS, defaultConfig, THINKING_LEVELS } from "../contracts.ts";

/**
 * Configuration validation and the read path. The `validateConfig` cases came
 * from contracts.test.ts, which is not where a reader looks for them (L5).
 *
 * `config.ts` is deliberately one mixed module — validation plus file access —
 * because once `path` is a required parameter both halves are independently
 * testable, which is what this file demonstrates: everything below either needs
 * no filesystem at all, or writes only into a temporary directory (T7).
 */

const valid = (over: Partial<AdvisorConfig> = {}): AdvisorConfig => ({ ...defaultConfig(), ...over });

test("advisorConfigPath puts the file beside pi's own agent state", () => {
	assert.equal(ADVISOR_CONFIG_FILENAME, "advisor.json");
	assert.equal(advisorConfigPath("/some/agent/dir"), join("/some/agent/dir", "advisor.json"));
});

test("validateConfig accepts the default configuration unchanged", () => {
	assert.deepEqual(validateConfig(defaultConfig()), defaultConfig());
	// A round trip through JSON is the real path, since this validates parsed text.
	assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(defaultConfig()))), defaultConfig());
});

test("validateConfig rejects anything that is not a configuration object", () => {
	for (const value of [undefined, null, 0, "", "{}", true, [], [defaultConfig()]]) {
		assert.equal(validateConfig(value), undefined, `${JSON.stringify(value)} is not a configuration`);
	}
	assert.equal(validateConfig({ ...defaultConfig(), unexpected: true }), undefined, "unknown keys are refused");
	assert.equal(validateConfig({ version: 1, enabled: true }), undefined, "a partial configuration is refused");
	assert.equal(validateConfig({ ...defaultConfig(), version: 2 }), undefined, "a future version is refused");
	assert.equal(validateConfig({ ...defaultConfig(), enabled: "yes" }), undefined);
});

test("validateConfig gates the model against the shared reference pattern", () => {
	assert.ok(validateConfig(valid({ model: "anthropic/big" })));
	assert.ok(validateConfig(valid({ model: undefined })), "no model configured is a valid state");
	for (const model of ["invalid", "a/b/c", "/b", "a/", "a b/c", "", 7 as unknown as string]) {
		assert.equal(validateConfig(valid({ model })), undefined, `${JSON.stringify(model)} is not storable`);
	}
});

test("validateConfig accepts every thinking level and nothing else", () => {
	for (const thinking of THINKING_LEVELS) {
		assert.ok(validateConfig(valid({ thinking })), `${thinking} is a documented level`);
	}
	for (const thinking of ["", "HIGH", "extreme", 3]) {
		assert.equal(validateConfig(valid({ thinking: thinking as AdvisorConfig["thinking"] })), undefined);
	}
});

test("validateConfig checks every limit at both of its bounds", () => {
	// Each cap is enumerated at min-1, min, max, max+1 rather than sampled, because
	// a wrong bound on any single one of these is a silent misconfiguration.
	const bounds: Array<[keyof typeof DEFAULT_LIMITS, number, number]> = [
		["maxConsultationsPerRun", 1, 10],
		["maxConsultationsPerSession", 1, 100],
		["maxAdvisorTurns", 1, 20],
		["maxReadOnlyToolCalls", 1, 50],
		["maxContextBytes", 4_096, 500_000],
		["maxAdvisorOutputTokens", 256, 16_000],
		["timeoutMs", 5_000, 600_000],
	];
	for (const [key, min, max] of bounds) {
		// maxConsultationsPerRun must not exceed maxConsultationsPerSession, so the
		// base sits at the widest gap: run at its floor, session at its ceiling.
		// Otherwise probing the session floor trips the pairing rule instead of the
		// bound under test.
		const base = { ...DEFAULT_LIMITS, maxConsultationsPerRun: 1, maxConsultationsPerSession: 100 };
		const at = (value: number) => validateConfig(valid({ limits: { ...base, [key]: value } }));
		assert.ok(at(min), `${key} should accept its minimum ${min}`);
		assert.ok(at(max), `${key} should accept its maximum ${max}`);
		assert.equal(at(min - 1), undefined, `${key} should reject ${min - 1}`);
		assert.equal(at(max + 1), undefined, `${key} should reject ${max + 1}`);
		assert.equal(at(min + 0.5), undefined, `${key} should reject a non-integer`);
		assert.equal(at(Number.NaN), undefined, `${key} should reject NaN`);
	}
	assert.equal(validateConfig(valid({ limits: { ...DEFAULT_LIMITS, extra: 1 } as never })), undefined);
	assert.equal(validateConfig(valid({ limits: undefined as never })), undefined);
});

test("validateConfig refuses a per-run budget larger than the per-session budget", () => {
	// The pair is only meaningful in one direction, and the inverse would let a
	// single run spend a session budget it does not have.
	const limits = { ...DEFAULT_LIMITS, maxConsultationsPerRun: 5, maxConsultationsPerSession: 4 };
	assert.equal(validateConfig(valid({ limits })), undefined);
	assert.ok(validateConfig(valid({ limits: { ...limits, maxConsultationsPerSession: 5 } })), "equal is allowed");
});

test("validateConfig refuses an additionalProtectedPaths entry that could escape the root", () => {
	const security = (additionalProtectedPaths: unknown[]) =>
		validateConfig(valid({ security: { redactKnownSecrets: true, additionalProtectedPaths } as never }));
	assert.ok(security([]));
	assert.ok(security(["private", "vault/keys"]));
	for (const entry of ["../secrets", "/etc", "a/../../b", "", "   ", "x".repeat(241), 7, null]) {
		assert.equal(security([entry]), undefined, `${JSON.stringify(entry)} must not be storable`);
	}
	assert.equal(validateConfig(valid({ security: { redactKnownSecrets: "yes" } as never })), undefined);
	assert.equal(validateConfig(valid({ security: undefined as never })), undefined);
});

test("validateConfig copies the nested objects rather than aliasing the input", () => {
	// The result is handed to callers that spread and store it; sharing the arrays
	// with the parsed JSON would let a later mutation reach validated state.
	const input = valid({ security: { redactKnownSecrets: true, additionalProtectedPaths: ["private"] } });
	const result = validateConfig(input);
	assert.ok(result);
	assert.notEqual(result.limits, input.limits);
	assert.notEqual(result.security.additionalProtectedPaths, input.security.additionalProtectedPaths);
	assert.deepEqual(result.security.additionalProtectedPaths, ["private"]);
});

test("formatConfig reports the fields a user needs to see, and no secrets", () => {
	const lines = formatConfig(valid({ model: "anthropic/big", enabled: true })).split("\n");
	assert.deepEqual(lines, [
		"enabled: true",
		"model: anthropic/big",
		"thinking: high",
		"limits: 3/run, 12/session, 6 turns, 8 reads, 4000 output tokens",
		"redaction: on",
	]);
	assert.ok(formatConfig(valid({ model: undefined })).includes("model: not configured"));
	assert.ok(
		formatConfig(valid({ security: { redactKnownSecrets: false, additionalProtectedPaths: [] } })).includes(
			"redaction: off",
		),
	);
});

test("loadConfig treats a missing file as the defaults, not as an error", async () => {
	// This is the first-run path: the advisor is disabled by default, so an absent
	// file means "not set up yet" rather than "broken".
	const directory = await mkdtemp(join(tmpdir(), "advisor-config-"));
	const loaded = await loadConfig(advisorConfigPath(directory));
	assert.deepEqual(loaded, { config: defaultConfig() });
	assert.equal(loaded.config?.enabled, false, "the default is off until configured");
	assert.equal(loaded.config?.model, undefined);
});

test("loadConfig separates an unreadable file from an invalid one (T6)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "advisor-config-"));

	// A directory where a file belongs is EISDIR, not ENOENT — it must not fall
	// through to the defaults, because that would silently discard real settings.
	await mkdir(advisorConfigPath(directory));
	assert.deepEqual(await loadConfig(advisorConfigPath(directory)), {
		error: "Advisor configuration cannot be read.",
	});

	const other = await mkdtemp(join(tmpdir(), "advisor-config-"));
	await writeFile(advisorConfigPath(other), "not json at all");
	assert.deepEqual(await loadConfig(advisorConfigPath(other)), { error: "Advisor configuration cannot be read." });

	const schema = await mkdtemp(join(tmpdir(), "advisor-config-"));
	await writeFile(advisorConfigPath(schema), JSON.stringify({ version: 1, enabled: true }));
	assert.deepEqual(await loadConfig(advisorConfigPath(schema)), { error: "Advisor configuration is invalid." });
});

test("loadConfig returns a validated configuration for a well-formed file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "advisor-config-"));
	const stored = valid({ enabled: true, model: "anthropic/big", thinking: "medium" });
	await writeFile(advisorConfigPath(directory), JSON.stringify(stored, null, 2));
	assert.deepEqual(await loadConfig(advisorConfigPath(directory)), { config: stored });
});

test("saveConfig refuses to write a configuration it would refuse to read", async () => {
	// Checked before any filesystem work, so an invalid configuration cannot leave
	// a partial file behind.
	const directory = await mkdtemp(join(tmpdir(), "advisor-config-"));
	const path = advisorConfigPath(directory);
	await assert.rejects(() => saveConfig({ ...valid(), model: "invalid" }, path), /Invalid advisor configuration/);
	assert.deepEqual(await loadConfig(path), { config: defaultConfig() }, "nothing was written");
});

test("saveConfig and loadConfig round-trip", async () => {
	const directory = await mkdtemp(join(tmpdir(), "advisor-config-"));
	const path = join(directory, "nested", "advisor.json");
	const stored = valid({ enabled: true, model: "openai/gpt-y", thinking: "off" });
	await saveConfig(stored, path);
	assert.deepEqual(await loadConfig(path), { config: stored }, "the directory is created as needed");
});
