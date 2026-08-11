import assert from "node:assert/strict";
import test from "node:test";
import {
	bounded,
	boundedOutput,
	EVIDENCE_TRUNCATION_MARKER,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	OUTPUT_TRUNCATION_NOTICE,
	REGION_TRUNCATION_MARKER,
	redactKnownSecrets,
	truncateMiddle,
} from "../outbound-text.ts";

/**
 * The last thing that runs before text leaves the machine, so the caps are
 * asserted at their exact boundaries — n-1, n, n+1 — rather than at
 * comfortably-inside sample values.
 *
 * Pure module, no fixtures needed (S1).
 */

test("redaction catches prefixed tokens at their length threshold", () => {
	// The pattern requires 16 or more characters after the prefix, which is what
	// keeps `sk_test` and similar short literals out of the redactor.
	assert.equal(redactKnownSecrets(`sk_${"a".repeat(15)}`), `sk_${"a".repeat(15)}`, "15 is below the threshold");
	assert.equal(redactKnownSecrets(`sk_${"a".repeat(16)}`), "[REDACTED_SECRET]");
	assert.equal(redactKnownSecrets(`sk_${"a".repeat(17)}`), "[REDACTED_SECRET]");
	for (const prefix of ["sk", "pk", "api"]) {
		for (const separator of ["-", "_"]) {
			assert.equal(redactKnownSecrets(`${prefix}${separator}${"b".repeat(20)}`), "[REDACTED_SECRET]");
		}
	}
});

test("redaction catches assignment forms and keeps the key visible", () => {
	// The key survives so the advisor can still see *that* a token is configured,
	// which is usually the relevant fact, without seeing its value.
	assert.equal(redactKnownSecrets("token=abc123"), "token=[REDACTED_SECRET]");
	assert.equal(redactKnownSecrets("API_KEY: xyz"), "API_KEY: [REDACTED_SECRET]");
	assert.equal(redactKnownSecrets("password : hunter2"), "password : [REDACTED_SECRET]");
	assert.equal(redactKnownSecrets("secret=s"), "secret=[REDACTED_SECRET]", "no minimum length on this branch");
	assert.equal(redactKnownSecrets("Secret=s"), "Secret=[REDACTED_SECRET]", "matching is case-insensitive");
	assert.equal(redactKnownSecrets("api-key=v"), "api-key=[REDACTED_SECRET]");
});

test("redaction leaves ordinary prose and near-miss identifiers alone", () => {
	// A redactor that fires on "tokenized" would quietly destroy the evidence it
	// is meant to be sanitising, so the negative cases matter as much as the
	// positive ones.
	for (const text of ["tokenized=abc", "the token is rotated weekly", "skater_dude_is_here", "public_key_id"]) {
		assert.equal(redactKnownSecrets(text), text, `${text} should survive untouched`);
	}
});

test("truncateMiddle keeps the head and the tail and marks the gap", () => {
	assert.equal(truncateMiddle("abcde", 5, REGION_TRUNCATION_MARKER), "abcde", "exactly at the cap is unchanged");
	assert.equal(truncateMiddle("abcd", 5, REGION_TRUNCATION_MARKER), "abcd", "under the cap is unchanged");
	const over = truncateMiddle("abcdefghij", 5, REGION_TRUNCATION_MARKER);
	assert.ok(over.startsWith("abc"), "the head survives");
	assert.ok(over.endsWith("j"), "the tail survives");
	assert.ok(over.includes(REGION_TRUNCATION_MARKER), "the advisor is told text was cut");
	assert.notEqual(EVIDENCE_TRUNCATION_MARKER, REGION_TRUNCATION_MARKER, "callers pick a marker that names the cut");
});

test("truncateMiddle can split a multi-byte character — a known, accepted limitation", () => {
	// Pinned rather than fixed (§17): the caps are byte-wise, so a cut can land
	// mid-sequence and surface as U+FFFD. It degrades one character and leaks
	// nothing, and changing it would be a behaviour change.
	const split = truncateMiddle("€".repeat(20), 10, REGION_TRUNCATION_MARKER);
	assert.ok(split.includes("�"), "a byte-wise cut through UTF-8 produces a replacement character");
});

test("bounded reports the byte cap at its exact boundary", () => {
	for (const [size, expected] of [
		[MAX_OUTPUT_BYTES - 1, false],
		[MAX_OUTPUT_BYTES, false],
		[MAX_OUTPUT_BYTES + 1, true],
	] as const) {
		const result = bounded("x".repeat(size), false);
		assert.equal(result.truncated, expected, `${size} bytes: truncated should be ${expected}`);
		assert.ok(Buffer.byteLength(result.text) <= MAX_OUTPUT_BYTES, "the result never exceeds the cap");
	}
});

test("bounded reports the line cap at its exact boundary", () => {
	for (const [count, expected] of [
		[MAX_OUTPUT_LINES - 1, false],
		[MAX_OUTPUT_LINES, false],
		[MAX_OUTPUT_LINES + 1, true],
	] as const) {
		const result = bounded(Array.from({ length: count }, (_, i) => `L${i}`).join("\n"), false);
		assert.equal(result.truncated, expected, `${count} lines: truncated should be ${expected}`);
		assert.ok(result.text.split("\n").length <= MAX_OUTPUT_LINES);
	}
});

test("bounded applies both caps and redacts last", () => {
	// Order matters: redaction runs on the already-capped text, so a secret that
	// was cut away is never scanned, and one that survives is always scanned.
	const oversized = `token=sk_abcdefghijklmnop\n${Array.from({ length: MAX_OUTPUT_LINES + 10 }, () => "x").join("\n")}`;
	const redacted = bounded(oversized, true);
	assert.equal(redacted.truncated, true);
	assert.match(redacted.text, /REDACTED_SECRET/);
	assert.doesNotMatch(redacted.text, /sk_abcdefghijklmnop/);

	const kept = bounded("token=sk_abcdefghijklmnop", false);
	assert.equal(kept.truncated, false);
	assert.match(kept.text, /sk_abcdefghijklmnop/, "redaction is the caller's choice");
});

test("boundedOutput appends the notice only when something was actually cut", () => {
	assert.equal(boundedOutput("short", false), "short");
	assert.ok(!boundedOutput("short", false).includes(OUTPUT_TRUNCATION_NOTICE));
	const long = boundedOutput(Array.from({ length: MAX_OUTPUT_LINES + 1 }, (_, i) => `L${i}`).join("\n"), false);
	assert.ok(long.endsWith(OUTPUT_TRUNCATION_NOTICE), "the notice is the last line");
	assert.ok(OUTPUT_TRUNCATION_NOTICE.includes(String(MAX_OUTPUT_LINES)), "the notice names the caps it enforces");
	assert.ok(OUTPUT_TRUNCATION_NOTICE.includes(String(MAX_OUTPUT_BYTES)));
});
