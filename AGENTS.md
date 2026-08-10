# AGENTS.md

## Read this first

`docs/PI_EXTENSIONS_BEST_PRACTICES.md` is the authoritative engineering standard for this repository.
Read it before changing any extension. It is not advisory.

- **MUST** rules are non-negotiable — breaking one is a defect, not a style disagreement.
  **SHOULD** rules are the default; deviating is allowed but needs a one-line comment in the code saying why.
- Rules are numbered (`L1`, `R2`, `A5`, `C3`, …). Cite the relevant IDs in commit messages and review notes.
- The standard is self-contained: the rules themselves, the measured evidence behind them (§17), the decisions
  taken and alternatives rejected (§18), the deliberate non-goals (§19), and the sources (§20). Check §18 before
  re-litigating a rule.
- The repository **is** in conformance — §16 records the current state, with no outstanding violations. The one
  deliberate exception is `advisor`, whose style pass is deferred until it is promoted (see below). Keep it that
  way: bring code into conformance as you touch it, and do not let a new file match old habits.
- The mechanical rules are enforced by the pre-commit hook, not by good intentions. If a check is in your way,
  fix the code — do not weaken the rule, and do not reach for `--no-verify` outside a deliberate WIP commit.

## Repository role

This repository is the source of truth for Francisco's private pi extensions.

Runtime extensions are loaded from:

- `~/.pi/agent/extensions/`

When changing an extension, update the version in this repo first, then sync the runtime location with:

```bash
bash sync-extensions.sh
```

Use `bash sync-extensions.sh --dry-run` when you want to inspect the sync plan first.
Then reload pi.

## What is in scope here

- One directory per extension, entrypoint at `<name>/index.ts`, plus its sibling modules,
  its `test/` directory, its `tsconfig.json`, and its `README.md`
- Repository tooling: the root `package.json`, `tsconfig.base.json`, `biome.json`,
  `.githooks/`, and `sync-extensions.sh`
- Documentation for extension usage and maintenance

pi auto-discovers exactly two shapes: `~/.pi/agent/extensions/*.ts` and
`~/.pi/agent/extensions/*/index.ts`. **New extensions use the directory form** (`L1`).
The split shape — `foo.ts` beside a `foo/` helper directory — is not allowed: it is one
`foo/index.ts` away from pi discovering the extension twice and registering it twice.

## Runtime sync

Only files pi actually loads may reach `~/.pi/agent/extensions/` (`L7`). No tests, no
`tsconfig*.json`, no `package.json`, no lockfiles, no `biome.json`, no `.githooks/`, no
docs. When you add a new kind of non-runtime file, update the `sync-extensions.sh`
exclusions **in the same commit**, and review `bash sync-extensions.sh --dry-run`
whenever the file layout changes (`C5`).

`sync-extensions.sh` is the only thing that writes to the runtime directory. Never edit
or copy into it by hand.

## Working expectations

- **Pure core, imperative shell** (`S1`). Every extension splits into a core that is pure —
  no `pi`, no `ctx`, no TUI, no clock, no filesystem — and a shell that does the effects.
  All decisions live in the core. This is the reason any of this is testable at all;
  `validation.ts`, `display.ts`, `option-layout.ts`, `format.ts`, and the permission-gate
  rule catalogue are the working examples.
- **Mark intentional constraints as intentional** (`D4`). Write "this extension
  intentionally guards `bash` only", not just "guards `bash`". Without the word, a future
  agent reads the gap as a bug and widens the blast radius.
- Keep changes focused and reviewable; one concern per commit, citing the rule IDs it satisfies.
- Prefer explicit tool contracts over clever or implicit behavior.
- Preserve stateless designs unless persistent state is clearly required.
- Comment the *why*, never the *what*.
- Avoid compatibility layers unless the user explicitly asks for them.
- Do not leave temporary debug code, scratch files, or dead paths behind.

## Agent-visible surface

**The tool schema and prompt text are the extension's real public API — the model is the
caller. Treat a schema change as a breaking API change.** See standard §6 for the full
`A`-series. The three that are most often got wrong:

- `A1` — use `StringEnum` from `@earendil-works/pi-ai` for string enums.
  `Type.Union`/`Type.Literal` is a runtime failure on Google's API, not a style preference.
- `A5` — validation failures the model can fix are returned as **normal tool results**, not
  thrown. The text must state what was wrong *and* show the correct shape.
- `A4` — every `promptGuidelines` bullet must name its own tool. Bullets are appended flat
  into a shared Guidelines section, so "use this tool when…" is unresolvable.
  `ask-user/test/index.test.ts` asserts this.

When the agent-facing contract changes, update in the same commit: the schema
descriptions, `promptSnippet`, `promptGuidelines`, the extension's own `README.md`, the
inline comments near the registration, and the root `README.md` if the change is
user-visible.

## Validation expectations

A change is done when all of these pass:

```bash
npm run typecheck              # tsc --build across all four extensions
node --test                    # the whole suite, from the repository root
npm run lint                   # biome check .
pi --list-models               # confirms extensions still load
bash sync-extensions.sh --dry-run   # review, then run it without --dry-run
```

Then `/reload` inside pi and a manual pass over the changed flow. For interactive
extensions this is **mandatory** (`T10`) — automated tests reduce how often it has to be
exhaustive, they do not replace it.

`node --test` is the only test runner (`T1`). It needs no flags on Node 24, and a bare
directory *argument* does not work — run it bare from the root, or pass a file glob such
as `node --test ask-user/test/*.test.ts`.

The first three commands are also the pre-commit hook. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

`core.hooksPath` is per-clone local config and cannot be committed, which is why it is
documented here. `git commit --no-verify` remains the escape hatch for a deliberate WIP
commit.

## Version anchor

All `@earendil-works/*` packages are pinned — exactly, no ranges — to the version of the
installed pi runtime, currently **`0.84.1`** per `pi --version` (`C2`). There is one
`package.json`, at the repository root.

On a pi upgrade: bump the pin, run `npm install`, re-run typecheck and tests, `/reload`,
and check pi's built-in tool list for names that now collide with an extension tool
(`N1`). Tool names are a one-way door — renaming one orphans the tool calls stored in
existing sessions.

## Current extensions

Each is the reference implementation for at least one rule area. When in doubt about how
to do something, copy the extension that already does it best.

### `ask-user/index.ts`
- Provides the `ask_user` TUI tool. TUI-only.
- **Reference for the agent-facing contract (`A1`–`A11`).** The strict select/freeText
  schema split, the model-fixable error results, and the prompt guidelines are the
  pattern to copy.
- Validate both the agent-visible schema/guidance and real TUI behavior after changes.

### `permission-gate/index.ts`
- Prompts before dangerous `bash` commands.
- **Reference for policy engineering (`P1`–`P6`).** It is a *guardrail, not a security
  boundary or shell parser* — pi ships no sandbox and extensions run with the user's full
  permissions, so an in-process gate cannot be more than that. State the same posture
  explicitly in any extension that gates, filters, or sandboxes.
- Rule order is behaviour: evaluation is first-match-wins. Every rule needs at least one
  positive **and** one negative test case (`P4`); the negatives are what stop
  false-positive creep.
- Be conservative when changing prompts, allow/deny behavior, or safety checks.

### `context-footer/index.ts`
- TUI-only custom footer with project metadata, agent state, and hard token-based context
  severity thresholds.
- **Reference for testability.** `test/index.test.ts` proves an entrypoint can be driven
  with no TUI and no pi runtime (`T4`); its generation counter is the pattern for guarding
  async work against session replacement (`E3`); its width tests loop over a range of
  widths rather than asserting a golden string (`T5`).
- Keep formatter tests and the interactive footer behavior aligned when changing layout.

### `advisor/index.ts`
- Configured read-only technical advisor exposing `consult_advisor({})`.
- **In flight.** It is bound by the structural rules only; its style pass — `F5` function
  lengths, the long line, the Biome reformat — is deferred until the extension is promoted
  to production-ready, so that noise stays out of the feature diff. `advisor/` is excluded
  from both the formatter and the linter in `biome.json`. **Do not reformat it meanwhile.**

## Sync note

This repo is authoritative, but pi loads from `~/.pi/agent/extensions/`.
Do not assume editing only this repo changes the live runtime until `bash sync-extensions.sh` has updated the runtime copy and pi has been reloaded.
