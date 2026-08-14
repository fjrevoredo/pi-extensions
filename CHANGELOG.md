# Changelog

One entry per coherent change, newest first. An entry groups however many commits the change took;
it is not a commit log, because `git log` is already that.

**This file records changes and nothing else.** It states no rules, settles no arguments, and
supersedes nothing. Rules live in [`docs/PI_EXTENSIONS_BEST_PRACTICES.md`](docs/PI_EXTENSIONS_BEST_PRACTICES.md),
decisions in its §16, deliberate absences in its §17. An entry that argues for a decision is in the
wrong document. The rules governing this file are `D6` and `D7`; when to write an entry and when to
read this file are in [`AGENTS.md`](AGENTS.md).

### How to add an entry

1. Take the id on the `Next id:` line below, and increment that line by one in the same edit.
2. Insert the entry directly under the `---` that closes this header, so the file stays newest first.
3. Bump `<ext>/version.ts` for every extension the entry names, and name the version it moved **to**
   on the `Scope:` line. MAJOR is an agent-facing contract change — the tool schema, or the prompt
   text a driver model reads (§6) — MINOR is new behaviour, PATCH is a fix, a refactor, or
   documentation.

### Entry format

Every entry is exactly this shape, line for line. `.github/scripts/check-changelog.sh` asserts it, so
a hand-written variation fails the build instead of rotting quietly.

    ## <id> — <title>
    <blank>
    Date: <ISO 8601 with offset>
    Scope: <item>, <item>, …
    <blank>
    <body: one or more paragraphs, at least one non-blank line>

- **`<id>`** is a decimal integer zero-padded to four digits (`0007`), never reused and never
  renumbered. Past `9999` it simply gets wider (`10000`): the padding is a minimum, not a fixed width.
  An id is a citable handle — `CL-7` in a commit message reads the way `L7` does — and a reused id
  destroys that permanently, since the citation may already be somewhere the check cannot see.
- **The separator** in the heading is an em dash with one space on each side.
- **`Date:`** is when the change landed. Produce it with `date -Iseconds`, which behaves identically
  on macOS and on GNU coreutils. The entries backfilled from history carry the timestamp of the last
  commit in their group.
- **`Scope:`** is a comma-separated list, one comma and one space between items. Each item is either
  `<extension> <semver>` — the extension directory name and the version it moved to — or the literal
  token `repo`, for a change belonging to no single extension: CI, the hook, the standard, the sync
  script. The two mix freely in one entry, because a change that adds a gate *and* fixes an extension
  is one change, and splitting it would be a lie about the history.
- **The title** is one line. The body says what moved and why, for a reader who has not seen the diff.
  Cite rule ids; do not cite commit hashes.

A body line may not begin with `## ` and may not be exactly `---`; both are structure. Indent either
by four spaces to quote it.

### Finding the commits for an entry

Entries carry no commit hashes, deliberately. An entry is written before the commit that contains it
exists, so a hash in it would be a guess or an amend of its own commit. Git is searched from here
instead of the other way round, which also survives a rebase or a squash, as a hash does not:

    git log -S'## 0007 ' -- CHANGELOG.md                             # what commit added entry 0007
    git log -S'EXTENSION_VERSION = "2.1.0"' -- advisor/version.ts    # what commit landed a version

### Grepping this file

    grep -n '^Next id: ' CHANGELOG.md            # the counter
    grep -n '^## 0007 ' CHANGELOG.md             # one entry, by id
    grep -n '^## [0-9]' CHANGELOG.md             # every entry heading
    grep -n '^Scope:.*advisor ' CHANGELOG.md     # every entry that moved advisor
    grep -h 'EXTENSION_VERSION' */version.ts     # what every extension is at right now

There is no current-versions table here on purpose. `version.ts` is the single source of truth for a
version, the newest `Scope:` line naming an extension is the only copy of it in this file, and the
check asserts those two agree. A third copy would be a third thing to forget.

Next id: 0018

---

## 0017 — Give every extension a version, and this repository a changelog

Date: 2026-08-14T09:19:25+02:00
Scope: repo

Until now the only record of what an extension had become was `git log`, which is a list of commits
rather than a list of changes, and nothing anywhere named the state an extension was in. Each
extension now carries `<ext>/version.ts`, and this file carries the changes those versions moved
through — sixteen entries reconstructed from the first 68 commits, then this one.

`.github/scripts/check-changelog.sh` asserts the schema above, the id counter, and the agreement
between each `version.ts` and the newest entry naming it. It runs as `npm run changelog` from the
pre-commit hook and from CI both, so `check-hook-parity.sh` keeps the two in step (§14). It
deliberately does not check that a commit added an entry: entries group many commits, so enforced from
a hook that rule would buy a junk entry per commit rather than a record anybody reads.

§17's "no release, publish, or deploy pipeline" was narrowed rather than dropped — no build artifact,
no publish, no registry, no tags, no deploy, and no compatibility layers. §16 holds the reasoning. A
version exists so a change can be named and found again; nothing depends on it, and nothing may start.

## 0016 — Surface the advisor's risks and confidence to the driver

Date: 2026-08-13T17:26:34+02:00
Scope: advisor 2.0.0

The driver saw an outcome and a summary, and the advisor's risk list and its own confidence — the two
fields most likely to change what a driver does next — were computed and then dropped. Both are now
rendered, the output budget was resized from 1,600 to 4,000 tokens against a measured 1,900-token
consultation, and a dead assignment left by the retry work was removed with the truncated path covered
end to end (A11, D5).

MAJOR, because the text a driver model reads is this extension's real public API (§6). The narrow
reading — that only `registerTool`'s schema counts, and `formatAdvice` output is merely a result
payload — would make this a MINOR. It was rejected: `A2` and `N6` both rest on the argument that what
the caller reads materially changes what the caller does, and a driver that now sees risks it never
saw is a caller whose input changed.

## 0015 — Record why a consultation was invalid

Date: 2026-08-13T17:16:31+02:00
Scope: advisor 1.2.0

An advice that failed validation surfaced as `invalid_response` with nothing pointing at the cause,
which is the failure mode `contracts.ts` warns about in its own module header. The specific reason is
now recorded and returned (A7, T8).

## 0014 — Retry a truncated advisor turn instead of failing it

Date: 2026-08-13T17:10:52+02:00
Scope: advisor 1.1.0

A turn cut off by the output cap failed the whole consultation, which spends the run's consultation
budget on nothing. It is now retried once, and the error the model can act on is returned as a normal
tool result rather than thrown (F4, A5).

## 0013 — Keep the third context tier distinguishable

Date: 2026-08-13T14:28:48+02:00
Scope: context-footer 1.0.3

Two of the context tiers rendered identically at the widths that matter, so the footer's threshold
signal was lost exactly where it was supposed to be loudest (U4, S1, T3). The tiers that remain
genuinely unreachable are now marked intentional, so a future agent reads the gap as a decision rather
than a bug (D4).

## 0012 — Consolidate the standard and retire the migration plan

Date: 2026-08-11T11:41:15+02:00
Scope: repo

Point-in-time status was removed from the rules that stay, every durable finding was rehomed out of
§15 and §16 into the rule it supports, `T11` was added, the conformance table and the migration plan
were deleted, and the appendices were renumbered with all 26 citations fixed. Three claims the
de-stating pass left inaccurate were then corrected.

The standard is the only artifact in this repository that can be corrected after the fact, which is
why every correction lands here rather than near the commit that made the original claim. That
observation is what `0017` builds on.

## 0011 — Bring advisor to full conformance and harden its path policy

Date: 2026-08-11T11:01:19+02:00
Scope: advisor 1.0.1

The largest extension was also the least conformant. Its entrypoint was reduced to wiring, and five
pure modules were split out of it — outbound bounding and redaction, the path policy, the turn policy,
evidence assembly, and the agent directory and loop clock, the last two injected rather than reached
for (L3, S1, L4, F3, F5, S2, S6, T7). Two real defects surfaced on the way and were fixed: protected
path names matched case-sensitively, and the advisor root was canonicalized more than once (P6, D2).

Every pure core then got direct tests, the path policy became table-driven with positive and negative
cases, the entrypoint and the consultation gate were driven through a fake pi, and the last untested
module was closed with A10's root contract pinned (T3, T4, T6, T7, T8, P4, L5). The security posture
and the policy's deliberate limits were written into the module headers, and Biome's formatter
exemption was dropped (P1, P3, D1, D2, D4, L6, C4).

PATCH, not MINOR: §17 forbids behaviour changes as part of conformance work, and the two fixes
corrected behaviour rather than adding any.

## 0010 — Add CI, and make L7 mechanically checkable for the first time

Date: 2026-08-10T17:02:49+02:00
Scope: repo

"No CI" was a non-goal justified by "enforcement is the local pre-commit hook", and that justification
does not survive inspection: `core.hooksPath` is per-clone local config that cannot be committed, so
the hook is absent in a fresh clone and in every new agent worktree — absent, that is, exactly where
agents work. The workflow runs the three npm scripts as separate guarded steps, so one run reports all
three failures rather than only the first (§14).

The deciding argument was `check-runtime-hygiene.sh`. `sync-extensions.sh` honours an overridden
`HOME`, so L7 — a MUST previously verified by a human reading a dry-run — became assertable: sync into
a throwaway `HOME`, then assert a positive invariant in both directions. `check-hook-parity.sh` keeps
the hook and the workflow calling the same scripts. The lockfile was committed so the transitive tree
stops floating, `engines.node` was declared, `.github/` was given its own sync exclusion, and the hook
was routed through the npm scripts so neither file defines a command (C2, C5, L7, §14, §17).

## 0009 — Extract the remaining pure cores and finish the READMEs

Date: 2026-08-10T15:15:30+02:00
Scope: ask-user 2.2.1, context-footer 1.0.2

`context-footer`'s responsive fallback search and `ask-user`'s display construction became pure
modules, and the wizard took a single `WizardDeps` object instead of a long positional list (S3, F3,
F5). The two missing extension READMEs were written and the root docs brought up to post-migration
reality (L6, D5).

## 0008 — Derive ask_user's footer key hints from the keybindings manager

Date: 2026-08-10T15:02:38+02:00
Scope: ask-user 2.2.0

The footer hints were hard-coded and silently wrong for anyone who had rebound a key. They are now
read from the keybindings manager, so they describe the session the user is actually in (U5).

## 0007 — One workspace, the directory shape, TypeScript everywhere, and Biome

Date: 2026-08-10T15:00:05+02:00
Scope: repo, ask-user 2.1.1, permission-gate 1.0.1, context-footer 1.0.1

The repository had drifted three separate ways — two pi versions, two indent styles, three test
conventions — and this is the pass that ended it. It became a single root workspace with a
`tsconfig.json` per extension, which brought 2,211 previously unchecked lines under `tsc` for the
first time (C1, C3, T9). `ask-user` and `permission-gate` adopted the directory shape with tests under
`test/`; `permission-gate`'s policy catalogue was ported from `.mjs` to TypeScript; `ask-user` dropped
parameter properties, which native type stripping rejects outright; `context-footer` got explicit
`.ts` import extensions, which dropped the `tsx` runner (L1, L5, R1, R2, R3, T1, P4). Biome was
configured and the tree reformatted once, and the tracked pre-commit hook was added (C4, §14).

Typechecking previously unchecked code was diagnostic rather than merely corrective: the first
typecheck of `permission-gate/core.ts` is what found `R1`'s `ToolCallEvent` narrowing gap.

PATCH for all three extensions. Conformance work moves, renames and reformats; §17 forbids it from
changing what an extension does, and nothing here did.

## 0006 — Ratify the pi extension best-practices standard

Date: 2026-08-10T14:37:23+02:00
Scope: repo

87 rules across twelve lettered areas, derived from what this repository already did rather than
imported, with the evidence measured and recorded rather than assumed. Strength is assigned by
enforceability, not by importance — a MUST that nothing checks devalues the ones that are real.
`AGENTS.md` binds it and deliberately does not summarise it (D5).

## 0005 — Add the advisor extension

Date: 2026-08-10T13:48:04+02:00
Scope: advisor 1.0.0

A configured read-only technical advisor exposing `consult_advisor({})`. It is the second extension
that can cause harm: it sends repository text to a third-party provider, so its path filter and its
redaction are policy in the same sense `permission-gate`'s catalogue is (P1–P6).

## 0004 — Give ask_user a multiline option layout

Date: 2026-08-07T14:37:59+02:00
Scope: ask-user 2.1.0

Options longer than one line were truncated rather than wrapped, so a question could present a choice
the user could not read. The select list now lays out multiline options.

## 0003 — Rework the ask_user option contract into tagged branches

Date: 2026-08-07T14:02:29+02:00
Scope: ask-user 2.0.0

Options were a loose shape with conditionally-required fields. They became a discriminated union of
select and freeText branches, each declaring its own `responseType` with `additionalProperties: false`,
which makes the invalid states unrepresentable in the schema rather than caught after the fact (A3).

MAJOR: the tool schema is this extension's public API, and every existing caller's payload shape moved.

## 0002 — Add the context footer

Date: 2026-08-07T12:57:13+02:00
Scope: context-footer 1.0.0

A two-row TUI footer with token-based context thresholds, cwd, git branch and status, session name,
agent phase, model, thinking level and cumulative cost, each row degrading through fallback layouts as
the terminal narrows.

## 0001 — The initial extension library

Date: 2026-07-13T14:26:44+02:00
Scope: ask-user 1.0.0, permission-gate 1.0.0

`ask-user`, a TUI-only clarification tool, and `permission-gate`, which prompts before dangerous
`bash` commands. These are the versions the record begins at, not a claim that anything changed on
this date.
