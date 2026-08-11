# AGENTS.md

## Read this first

`docs/PI_EXTENSIONS_BEST_PRACTICES.md` is the authoritative engineering standard for this
repository — the rules, the measured evidence behind them, and the decisions already settled.
Read it before changing any extension. It is not advisory.

It is deliberately **not summarised here.** This file covers only how to *work* in this repo:
the runtime model, the setup, and what lives where. Anything that is a rule lives in the
standard and is cited by ID (`L1`, `A5`, `C3`, …) — cite those IDs in commit messages and
review notes too. Check §18 before re-litigating a decision, and §19 before adding something
the standard deliberately leaves out.

There are no exemptions. Every extension is bound by every rule area — being small, being
new, or not being a *gate* exempts nothing — and nothing is excluded from Biome.

## Repository role

This repository is the source of truth for Francisco's private pi extensions. pi loads them
from `~/.pi/agent/extensions/`, so editing here changes nothing until you sync:

```bash
bash sync-extensions.sh --dry-run   # review the plan
bash sync-extensions.sh             # apply it
```

Then `/reload` inside pi.

`sync-extensions.sh` is the only thing that writes to the runtime directory. Never edit or
copy into it by hand: the next sync runs `rsync --delete` and will silently discard whatever
you put there.

## Setup

```bash
npm install
git config core.hooksPath .githooks
```

The second enables the pre-commit hook (§14). `core.hooksPath` is per-clone local config that
cannot be committed — which is why this command needs documenting, and also why the hook is
*not* the gate. **If you are working in a fresh clone or a new worktree and have not run it,
you have no hook.** The hook is a ~3-second local convenience; CI is what always runs.

## Working in this repo

- One concern per commit, citing the rule IDs it satisfies. Sequence a multi-commit change
  cheapest and lowest-risk first, and reformat last so no file is touched twice. Every step
  should be independently revertible: stopping part-way must leave the repo consistent.
- Bring code into conformance as you touch it. Do not let a new file match old habits.
- The hook **and CI** are the enforcement, not good intentions. If a check blocks you, fix the
  code — do not weaken the rule. `--no-verify` is for deliberate WIP commits only, and it
  skips the hook, not CI: the same three checks run again in `.github/workflows/ci.yml`.
- Prefer small, reviewable changes and explicit contracts over clever behaviour.
- Do not leave temporary debug code, scratch files, or dead paths behind.

Three things about a **new extension** are easy to forget, and every one of them fails
silently rather than loudly: its `references` entry in the root `tsconfig.json` (`C3`), its
`README.md` (`L6`), and any `sync-extensions.sh` exclusion it needs for a new kind of
non-runtime file (`L7`, `C5`).

The third is the one that keeps happening, and not only for extensions — `.githooks/` needed
its own explicit exclusion, and so did `.github/`. Any new top-level directory does. You can
check the outcome locally instead of reasoning about rsync patterns:

```bash
bash .github/scripts/check-runtime-hygiene.sh
```

It syncs into a throwaway `HOME` and asserts what landed, in both directions. CI runs it too.

Two more worth knowing before you go looking: the tool schema and prompt text are an
extension's real public API, so a schema change is a breaking change (§6); and upgrading pi
is a defined procedure, not just a version bump (`C2`, `N1`).

## Validation

The definition of done is standard §13. In short:

```bash
npm run typecheck
node --test
npm run lint
bash sync-extensions.sh --dry-run   # then sync
```

…then `/reload` and a manual pass over the changed flow, which is mandatory for TUI
extensions (`T10`). The first three commands are the pre-commit hook, so in practice only the
last two are manual.

`pi --list-models` is deliberately **not** in this list. It exits 0 against an extension that
cannot be imported at all (§17), so it never was the load check it looked like. `node --test`
is: the T4 harnesses call every extension's default export. Load errors that only appear in a
real session show up at `/reload`, which is another reason that step is not optional.

## Current extensions

Each is the reference implementation for at least one rule area. When in doubt about
how to do something, copy the extension that already does it best. Each has its own
`README.md` with its contract and test instructions.

| Extension | What it is | Reference for |
|---|---|---|
| `ask-user/` | `ask_user` — a TUI-only clarification tool | the agent-facing contract, `A1`–`A11` |
| `permission-gate/` | prompts before dangerous `bash` commands | policy engineering, `P1`–`P6` |
| `context-footer/` | two-row TUI footer with token-based context thresholds | testability — `T4`, `E3`, `T5` |
| `advisor/` | read-only technical advisor exposing `consult_advisor({})` | outbound data safety, `P1`–`P6`; `S1` at scale |

Two need extra care:

- **`permission-gate`** is the only safety-critical extension. Be conservative with prompts,
  allow/deny behaviour, and the rule catalogue — rule *order* is behaviour, not formatting
  (`P3`).
- **`advisor`** is the other extension that can cause harm: it sends repository text to a
  third-party provider. Its path filter and its redaction are policy in the same sense
  permission-gate's catalogue is — the module headers say what each intentionally does not
  cover, and widening either widens what leaves the machine (`P1`–`P6`).
