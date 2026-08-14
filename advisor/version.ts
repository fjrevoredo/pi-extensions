/**
 * The version of the `advisor` extension.
 *
 * MAJOR is an agent-facing contract change — the tool schema, or the text a driver model reads (§6)
 * — MINOR is new behaviour, PATCH is a fix, a refactor, or documentation. Nothing is tagged and
 * nothing is published: the number exists so a change can be named in `CHANGELOG.md` and found again
 * in git, and no consumer depends on it (§17).
 *
 * Nothing imports this and nothing is required to. It is a record, not a runtime input.
 *
 * **Not `ADVISOR_VERSION` in contracts.ts.** That is a different number for a different thing: the
 * advisor's *config-file* schema version, which `validateConfig` compares against the `version` field
 * of `advisor.json` and refuses to migrate silently. Bumping that one invalidates the stored
 * configuration of every user, and the advisor drops to unconfigured with nothing pointing at the
 * cause. Bumping this one invalidates nothing. Neither follows the other.
 *
 * This file is read as text as well as compiled: `.github/scripts/check-changelog.sh` parses it with
 * a fixed pattern and asserts it matches the newest changelog entry naming this extension. Keep it
 * exactly one exported const, on one line, in this form.
 */
export const EXTENSION_VERSION = "2.0.0";
