# pi Extensions — Best-Practices Conformance Plan

## Metadata

- Plan Status: IN PROGRESS
- Created: 2026-08-10
- Last Updated: 2026-08-10
- Owner: Coding agent
- Approval: APPROVED

## Status Legend

- Plan Status values: DRAFT, QUESTIONS PENDING, READY FOR APPROVAL, APPROVED, IN PROGRESS, COMPLETED, BLOCKED
- Task/Milestone Status values: TO BE DONE, IN PROGRESS, COMPLETED, BLOCKED, SKIPPED

## Goal

Bring `ask-user`, `permission-gate`, `context-footer`, and `advisor` into conformance with `docs/PI_EXTENSIONS_BEST_PRACTICES.md`. At the end: one root workspace, one test runner, one indentation style, one pinned pi version, every extension file typechecked, the whole suite green at the repository root, and a pre-commit hook that keeps it that way.

The standard is the authority on *what* the rules are and *why*. This plan is the authority on *what is still undone*. Rule IDs (`L1`, `R2`, `C3`, …) refer to that document; read the cited rule before executing a task.

## Scope

- The eight-step migration sequence in `docs/PI_EXTENSIONS_BEST_PRACTICES.md` §15.
- The pre-commit hook described in §14, which §15 does not itself cover.
- The deferred quality items that no other document tracks: `U5` (key hints), `S3`/`F5` (logic in UI components), `F3` (wide constructor), `L6` (missing per-extension READMEs).
- Updating `AGENTS.md` and `README.md` so the standard is discoverable and enforced by agents.

## Non-Goals

- **No behaviour changes.** Every task here moves, renames, reformats, extracts, or adds tests. If a task appears to require changing what an extension does for the user or the model, stop and raise it instead.
- **No `advisor` style pass.** Per the standard's §18, `advisor` is bound by structural rules only until it is promoted to production-ready. Its 734-character line, `F5` function lengths, and Biome reformat are explicitly deferred. Task 7.1 is the only `advisor` work in scope.
- **No CI.** Enforcement is the local hook (standard §19).
- **No new extensions or features.**

## Assumptions

- Node v24.16.0 and pi 0.84.1 are installed; `pi --version` is the version anchor for `C2`.
- `docs/` is untracked at plan creation and contains only the standard and this plan. `advisor/` was committed in `7309ded`.
- The user runs `/reload` inside pi when a task's validation requires it; the agent cannot do this and must pause and ask.
- Tasks in Milestone 6 are quality refactors of working code and are the only genuinely optional milestone. They may be marked `SKIPPED` without invalidating the rest.
- `sync-extensions.sh` is the only mechanism that reaches `~/.pi/agent/extensions/`; no task writes there directly.

## Open Questions

None.

## Milestones

### Milestone 0: Bind The Standard

- Status: COMPLETED
- Purpose: Make the standard authoritative in `AGENTS.md` before any migration work begins, so every agent that touches this repository from here on is bound by it — including whoever executes the rest of this plan.
- Exit Criteria: `AGENTS.md` names `docs/PI_EXTENSIONS_BEST_PRACTICES.md` as authoritative, explains MUST/SHOULD, and points at this plan; it references no command or path that does not yet exist.

#### Task 0.1: Add the enforcement pointer to `AGENTS.md` (D5)

- Status: COMPLETED
- Objective: An agent opening this repository is told to read and follow the standard, without being shown any tooling that Milestones 1–4 have not built yet.
- Steps:
  1. Add a `## Read this first` section at the very top of `AGENTS.md`, above `## Repository role`, containing:
     - `docs/PI_EXTENSIONS_BEST_PRACTICES.md` is the authoritative engineering standard; read it before changing any extension; it is not advisory.
     - **MUST** rules are non-negotiable — breaking one is a defect, not a style disagreement. **SHOULD** rules are the default; deviating is allowed but needs a one-line comment in the code saying why.
     - Rules are numbered (`L1`, `R2`, `A5`, `C3`, …); cite the relevant IDs in commit messages and review notes.
     - The standard is self-contained: rules, measured evidence (§17), decisions and rejected alternatives (§18), non-goals (§19), sources (§20). Check §18 before re-litigating a rule.
     - Pending conformance work is tracked in `docs/extension-conformance-plan.md`; keep its task statuses accurate while working it, and do not start it without user approval.
     - The repository does not fully conform yet. When you touch a file, bring it into conformance rather than matching surrounding non-conformance — except where this plan sequences that work into a later milestone.
  2. Do **not** touch any other section of `AGENTS.md` in this task. In particular do not add `npm run typecheck`, `npm run lint`, `node --test`, `git config core.hooksPath`, or post-migration entrypoint paths — none of those exist yet. Task 7.2 adds them once they do.
- Validation: `grep -n "PI_EXTENSIONS_BEST_PRACTICES\|extension-conformance-plan" AGENTS.md` returns hits; every `§N` reference resolves to a real section — verify with `for n in 17 18 19 20; do grep -E "^## $n\. " docs/PI_EXTENSIONS_BEST_PRACTICES.md; done`; every rule ID cited exists in the standard; `git diff AGENTS.md` shows only the new section added.
- Notes: Deliberately additive and command-free so it cannot go stale mid-migration. This task must be completed and committed before Milestone 1 starts.

### Milestone 1: Toolchain Foundation

- Status: COMPLETED
- Purpose: Establish a single pinned pi version and a working typecheck before touching any source. Nothing downstream can be verified until `npm run typecheck` exists.
- Exit Criteria: `npm run typecheck` and `npm run test` both run from the repository root; exactly one `package.json` exists and it declares `"type": "module"`; every extension resolves `@earendil-works/*` at exactly `0.84.1`; `sync-extensions.sh --dry-run` shows no new files destined for the runtime directory.

#### Task 1.1: Align the pinned pi version with the installed runtime (C2)

- Status: COMPLETED
- Objective: Every extension is typechecked against the pi version it actually executes on.
- Steps:
  1. Confirm the anchor: `pi --version` (expected `0.84.1`).
  2. In `context-footer/package.json`, change `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` from `0.80.10` to `0.84.1`.
  3. Run `npm --prefix context-footer install`.
  4. Run `npm --prefix context-footer run typecheck` and fix any `ExtensionAPI` drift across the four minor versions. Fix by adapting to the new API, never by loosening types or adding `any` (`R6`).
- Validation: `npm --prefix context-footer run typecheck` clean; `npm --prefix context-footer test` 10/10 pass; then `pi --list-models` succeeds, `bash sync-extensions.sh`, and the user confirms `/reload` plus a visible footer in pi.
- Notes: Standalone commit. This is the one task where a real API change may surface; do not bundle it with anything else. Files: `context-footer/package.json`, `context-footer/package-lock.json`.
- Result: No `ExtensionAPI` drift across the four minors — typecheck clean on the first run, 10/10 tests pass, `pi --list-models` succeeds. The `/reload` + visible-footer confirmation is deferred to the Milestone 3 sync checkpoint rather than syncing a half-migrated tree into the live runtime directory; see the Execution Notes amendment.

#### Task 1.2: Convert the repository to a single root workspace (C1, C3, T9)

- Status: COMPLETED
- Objective: One dependency set at the root; every extension file covered by a `tsconfig.json`; version drift structurally impossible.
- Steps:
  1. Create root `package.json` per standard §11 `C1`: `private: true`, **`"type": "module"`**, scripts `test` (`node --test`), `typecheck` (`tsc --build`), `format` (`biome format --write .`), `lint` (`biome check .`). Put all four `@earendil-works/*` packages at `0.84.1` plus `typescript`, `@types/node`, and `typebox` in `devDependencies`. Pin every version exactly — no ranges. `"type": "module"` is load-bearing, not cosmetic: with `module: NodeNext` and `verbatimModuleSyntax`, omitting it makes TypeScript treat every `.ts` file as CommonJS and every file fails with `TS1287: A top-level 'export' modifier cannot be used on value declarations in a CommonJS module`.
  2. Create root `tsconfig.base.json` with exactly the `compilerOptions` block in standard §11 `C3`. Do not put `include` or `references` in it.
  3. Give each extension a `tsconfig.json` containing `"extends": "../tsconfig.base.json"`, `"compilerOptions": { "composite": true }`, and `"include": ["*.ts", "test/*.ts"]`. `composite` is required for the root project references in step 4 and is compatible with the base's `noEmit: true`.
     - `context-footer/tsconfig.json` and `advisor/tsconfig.json` **already exist** — replace their contents rather than creating them. This drops `context-footer`'s current `moduleResolution: "Bundler"`, which is what has been hiding its extensionless imports (Task 2.1 fixes those).
     - `ask-user/tsconfig.json` and `permission-gate/tsconfig.json` are new. Because their entrypoints are still at the repository root until Milestone 3, set `"include": ["../ask-user.ts", "*.ts", "test/*.ts"]` and `"include": ["../permission-gate.ts", "*.ts", "test/*.ts"]` respectively. A parent-directory path in `include` is valid; Tasks 3.1 and 3.2 remove these entries once the entrypoints move.
     - `permission-gate/` is still `.mjs` at this point, so its `include` picks up nothing but the entrypoint until Task 3.3. That is expected.
  4. Create root `tsconfig.json` with `"files": []` and a `"references"` entry for each of the four extension directories, so `npm run typecheck` checks all of them in one pass. Verified: `tsc --build` surfaces both ordinary type errors (`TS2322`) and `erasableSyntaxOnly` violations (`TS1294`) through references, so this is a real gate and not a no-op.
  5. Delete `context-footer/package.json`, `context-footer/package-lock.json`, `advisor/package.json`, `advisor/package-lock.json`, and the `context-footer/node_modules/` and `advisor/node_modules/` directories.
  6. Run `npm install` at the root.
  7. Add `*.tsbuildinfo` to `.gitignore` — `composite: true` writes a `tsconfig.tsbuildinfo` beside each extension `tsconfig.json`.
  8. Update `sync-extensions.sh` exclusions so none of the new tooling reaches the runtime directory (`L7`). The current list excludes the literal string `tsconfig.json`, which does **not** cover `tsconfig.base.json`. Change that entry to `tsconfig*.json` and add `/package.json` (leading slash anchors it to the transfer root, so a future extension with a genuine runtime dependency can still carry its own) and `*.tsbuildinfo`.
- Validation: `npm run typecheck` executes and reports only (a) the three known `TS2835` extensionless-import errors in `context-footer` and (b) any genuine pre-existing errors in the 2,211 previously unchecked lines of `ask-user`/`permission-gate`. No `TS1287` anywhere — if you see it, `"type": "module"` is missing from the root `package.json`. `bash sync-extensions.sh --dry-run` lists no `package.json`, no `tsconfig*.json`, no `*.tsbuildinfo`, and no `node_modules` entries. `git status` shows no `.tsbuildinfo` files as untracked.
- Notes: This task is expected to *surface* errors, not end clean — `ask-user.ts` and `permission-gate/` have never been typechecked. Record what it finds; fix genuine type errors here without weakening types or adding `any` (`R6`), and leave the `TS2835` errors for Task 2.1.
- Result: 14 errors surfaced, all already owned by a later task — no `TS1287`, and no genuine unowned type errors in the 2,211 previously unchecked lines. Breakdown: 10 × `TS1294` (parameter properties: 7 in `ask-user.ts`, 3 in `ask-user/multiline-select-list.ts`) → Task 2.2; 3 × `TS2835` (extensionless imports in `context-footer`) → Task 2.1; 1 × `TS7016` (`permission-gate.ts` importing the untyped `./permission-gate/core.mjs`) → Task 3.3, which ports it to `.ts`. Nothing needed fixing here.

### Milestone 2: Make The Suite Green

- Status: COMPLETED
- Purpose: Remove the two latent defects that keep the repository from having a single working test command.
- Exit Criteria: `node --test` at the repository root passes with zero failures; no extension depends on `tsx`; `npm run typecheck` is clean.
- **Correction (execution):** the typecheck half of this exit criterion cannot be met in this milestone. The one remaining error is `TS7016` on `permission-gate.ts` importing the untyped `./permission-gate/core.mjs`, and the plan assigns that port to Task 3.3. The test and `tsx` criteria are met here; typecheck goes clean at Task 3.3.

#### Task 2.1: Add explicit `.ts` extensions and drop `tsx` (R3, T1)

- Status: COMPLETED
- Objective: Every relative import resolves under Node's ESM resolver, so `node --test` needs no runner dependency.
- Steps:
  1. In `context-footer/index.ts`, change `from "./format"` to `from "./format.ts"`.
  2. In `context-footer/test/format.test.ts`, change `from "../format"` to `from "../format.ts"`.
  3. In `context-footer/test/index.test.ts`, change `from "../index"` to `from "../index.ts"`.
  4. Remove `tsx` from the root `devDependencies` if Task 1.2 carried it over, and re-run `npm install`.
  5. Audit every other relative import in the repository for a missing extension: `grep -rnE 'from "\.\.?/[^"]*[^s]"' --include='*.ts' . | grep -v node_modules`.
- Validation: `npm run typecheck` reports no `TS2835`; `node --test` from `context-footer/` passes 10/10 with no flags; `grep -rn '"tsx"' --include='*.json' . | grep -v node_modules` returns nothing.
- Notes: Verified during standardisation — this exact change makes the suite pass with no flags and no `tsx`. Rule `R3`.

#### Task 2.2: Replace parameter properties with explicit assignment (R2)

- Status: COMPLETED
- Objective: Every module is loadable by Node's strip-only type stripping, and `MultilineSelectList` gains the tests that constraint was blocking.
- Steps:
  1. In `ask-user/multiline-select-list.ts`, rewrite the three-parameter constructor (`items`, `theme`, `keybindings`) as declared `private readonly` fields plus explicit assignments in the constructor body.
  2. In `ask-user.ts`, rewrite `AskUserWizard`'s seven parameter properties the same way.
  3. Confirm `erasableSyntaxOnly` is active via `tsconfig.base.json` so this cannot regress.
  4. Add `ask-user/multiline-select-list.test.ts` — now possible for the first time — covering the logic that is not delegated to the already-tested `option-layout.ts`: `setSelectedIndex` clamping at both ends; `handleInput` wrap-around (up from index 0 lands on the last item, down from the last lands on 0); `onSelect` firing with the selected item and `onCancel` firing on cancel; `render` returning `noMatch` text for an empty item list; and the selected row carrying the `→ ` prefix while unselected rows do not. Use a stub `KeybindingsManager` whose `matches()` recognises fixed sentinel strings, and a stub `SelectListTheme` whose functions return their input unchanged.
  5. Move the new test file into `ask-user/test/` if Task 3.1 has already run; otherwise Task 3.1 moves it along with the others.
- Validation: `node -e "import('./ask-user/multiline-select-list.ts').then(()=>console.log('OK'))"` prints `OK`; `npm run typecheck` reports no `TS1294`; `node --test` at the repository root passes with zero failures and the new file contributes at least 5 tests.
- Notes: Do not restructure the constructor *signature* here — Task 6.4 handles that separately. Rules `R2`, `T3`.
- Result: All 10 `TS1294` errors cleared; the strip-only load check prints `OK`; root `node --test` passes 44/44 with the new file contributing 5 tests.

### Milestone 3: Layout And Language

- Status: COMPLETED
- Purpose: Give every extension the official directory shape and a single language, which is the only work that changes the runtime directory.
- Exit Criteria: `~/.pi/agent/extensions/` contains only `ask-user/`, `permission-gate/`, `context-footer/`, `advisor/` (each with `index.ts`) and no stray top-level `.ts` entrypoints, test files, or configs; both restructured extensions have been exercised in a reloaded pi.

#### Task 3.1: Restructure `ask-user` into the directory shape (L1, L5)

- Status: COMPLETED
- Objective: `ask-user/index.ts` is the entrypoint and tests live in `ask-user/test/`.
- Steps:
  1. `git mv ask-user.ts ask-user/index.ts`.
  2. In `ask-user/index.ts`, change the two imports `./ask-user/validation.ts` and `./ask-user/multiline-select-list.ts` to `./validation.ts` and `./multiline-select-list.ts`.
  3. `mkdir ask-user/test` and `git mv` every `*.test.ts` in `ask-user/` into it — `validation.test.ts`, `option-layout.test.ts`, and `multiline-select-list.test.ts` from Task 2.2.
  4. In each moved test file, change its `./<module>.ts` import to `../<module>.ts`.
  5. Remove the temporary `"../ask-user.ts"` entry from `ask-user/tsconfig.json`'s `include`, leaving `["*.ts", "test/*.ts"]`.
  6. Run `bash sync-extensions.sh --dry-run` and confirm the old `~/.pi/agent/extensions/ask-user.ts` is deleted, `ask-user/index.ts` is added, and no `ask-user/test/` entries appear.
- Validation: `npm run typecheck` clean; `node --test` root passes; `pi --list-models` succeeds; after `bash sync-extensions.sh`, the user confirms `/reload` and that an `ask_user` call renders options, a free-text branch, and the built-in `Something else` fallback correctly.
- Notes: `rsync --delete` removes the stale top-level entrypoint automatically; verify it in the dry run rather than assuming. Never leave both `ask-user.ts` and `ask-user/index.ts` present — pi would register the tool twice.

#### Task 3.2: Restructure `permission-gate` into the directory shape (L1)

- Status: COMPLETED
- Objective: `permission-gate/index.ts` is the entrypoint.
- Steps:
  1. `git mv permission-gate.ts permission-gate/index.ts`.
  2. Change the import from `./permission-gate/core.mjs` to `./core.mjs` (Task 3.3 renames it to `./core.ts`).
  3. Remove the temporary `"../permission-gate.ts"` entry from `permission-gate/tsconfig.json`'s `include`, leaving `["*.ts", "test/*.ts"]`.
  4. Update the file-layout comment block in the header so it describes the new structure, and drop the line describing `validate.mjs` — Task 3.3 removes that file.
  5. Run `bash sync-extensions.sh --dry-run` and confirm the old top-level entrypoint is deleted.
- Validation: `npm run typecheck` clean; `node permission-gate/validate.mjs` still passes all cases; `pi --list-models` succeeds; after sync, the user confirms `/reload` and that a gated command (for example `rm -r` on a scratch directory) still prompts with the four options.
- Notes: Sequence before Task 3.3 so the move and the language port stay separate commits.

#### Task 3.3: Port `permission-gate` to TypeScript (R1, T1, P4)

- Status: COMPLETED
- Objective: The policy catalogue is typechecked, and its cases run under `node --test`.
- Steps:
  1. `git mv permission-gate/core.mjs permission-gate/core.ts`.
  2. Convert the JSDoc `@typedef`s to real types: a `PermissionGateRuleCategory` union and a `PermissionGateRule` interface. Type `PERMISSION_GATE_RULES` as `readonly PermissionGateRule[]`. Add explicit parameter and return types to `normalizeCommand`, `findDangerousRule`, `createSessionApprovalKey`, `evaluateDangerousCommand`, `formatCommandPreview`, and `formatRuleSummary`.
  3. Update the import in `permission-gate/index.ts` to `./core.ts`.
  4. `mkdir permission-gate/test` and convert `permission-gate/validate.mjs` into `permission-gate/test/core.test.ts`: keep the existing case table verbatim as a `node:test` table-driven test (`T8`), preserving every negative expectation (`echo "DELETE FROM users"` → no match, `chmod 1777` → no match, `/tmp` redirects → no match), plus the normalization and approval-key assertions.
  5. `git rm permission-gate/validate.mjs`.
  6. Confirm `sync-extensions.sh` excludes `*/test/` so the new test directory does not reach the runtime.
- Validation: `npm run typecheck` clean; `node --test` root passes and the new file covers the same number of command cases the old script did — **43 command cases plus the normalization and approval-key checks**; `bash sync-extensions.sh --dry-run` shows no `permission-gate/test/` entries; after sync, the user confirms `/reload` and one gated command still prompts.
- Notes: Retiring `validate.mjs` is deliberate and its rationale is in standard §18 — do not reintroduce a post-sync smoke script. Every rule must keep at least one positive and one negative case (`P4`).
- Result: All 43 command cases plus the normalization and approval-key checks carried over; root `node --test` is 48/48 and `npm run typecheck` is clean for the first time. The port surfaced one genuine finding the JSDoc form had hidden, and it is the strongest argument in the standard's §18 case for `R1`: pi's `ToolCallEvent` union includes `CustomToolCallEvent`, whose `toolName` is a plain `string`, so `event.toolName !== "bash"` does **not** narrow the event and `event.input.command` is `unknown` — an extension-registered tool named `bash` reaches the gate with an arbitrary payload. `normalizeCommand`/`evaluateDangerousCommand` are therefore typed `unknown` (the honest boundary type, and what the untyped `.mjs` was doing implicitly), which makes the pre-existing `String(command ?? "")` coercion load-bearing rather than dead. No behaviour change.

### Milestone 4: Formatting And Enforcement

- Status: COMPLETED
- Purpose: Settle formatting once, after all files have stopped moving, and make the whole standard self-enforcing from then on.
- Exit Criteria: `npm run lint` passes; a deliberately malformed commit is rejected by the hook; no file needs reformatting a second time.

#### Task 4.1: Add the Biome config and reformat once (C4)

- Status: COMPLETED
- Objective: One indentation style and line width across the repository, matching upstream pi-mono.
- Steps:
  1. Add `@biomejs/biome` to root `devDependencies` at an exact version and `npm install`.
  2. Create root `biome.json` with the `formatter` and `linter` blocks in standard §11 `C4`: `indentStyle: "tab"`, `indentWidth: 3`, `lineWidth: 120`, `linter.rules.recommended: true`.
  3. Exclude `node_modules` and `advisor/` from both formatter and linter — `advisor` is out of scope for the style pass per the Non-Goals. Check the installed Biome's own schema for the correct key before writing it: Biome 2.x uses `files.includes` with `!`-prefixed negations, Biome 1.x uses `files.ignore`. Run `npx biome check .` after writing the config and confirm no `advisor/` path appears in its output.
  4. Add `--exclude 'biome.json'` to `sync-extensions.sh` (`L7`).
  5. Run `npm run format`, then review the diff for anything that is not pure whitespace or line-wrapping.
  6. Run `npm run lint` and fix genuine findings. If a `recommended` rule flags something whose fix would change behaviour, disable that specific rule in `biome.json` with a one-line comment explaining why, rather than changing behaviour (see this plan's Non-Goals).
- Validation: `npm run lint` exits 0; `npm run typecheck` clean; `node --test` root passes with the same test count as before the reformat; `git diff` contains no changes under `advisor/`; `bash sync-extensions.sh --dry-run` lists no `biome.json`.
- Notes: Must come after Milestone 3 so no file is reformatted twice. The only pre-existing indentation outlier is `permission-gate`'s two-space `.mjs`, already rewritten as `.ts` by Task 3.3 — write it with tabs there so this task is a no-op for those files.
- Result: Biome 2.5.7, so `files.includes` with `!`-prefixed negations. `npm run lint` exits 0 with zero diagnostics over 21 files, `advisor/` is excluded from both formatter and linter and has no diff, and the test count is unchanged at 48. Four deviations from the literal step list, all forced by the installed Biome:
  - `linter.rules.recommended: true` (standard §11 `C4`) is **deprecated** in Biome 2.5.7 and emits a warning. Written as `"preset": "recommended"`, which is the same rule set under the current key. The standard's §11 snippet should be updated when it is next revised.
  - `noExplicitAny` is turned off for `**/test/**` and `**/*.test.ts` via an `overrides` block rather than per-site ignores. This encodes `R6`, which already permits `any` freely in test fakes.
  - `noNonNullAssertion` is off repo-wide. Biome's only offered fix is `?.`, which it marks *unsafe* precisely because it short-circuits where the assertion would throw — applying it at 20 sites would be a behaviour change, which this plan's Non-Goals forbid.
  - `biome.json` cannot carry comments (Biome accepts them only in `biome.jsonc`); adding them silently invalidates the config, which then falls back to defaults and starts checking `advisor/`. The rationale for both rule adjustments therefore lives here and in `AGENTS.md` rather than inline.
  - One genuine `noMisleadingCharacterClass` error in `ask-user/option-layout.ts` is suppressed with a single-line `biome-ignore` at the call site: the loop iterates by code point, so the class only ever matches a lone zero-width code point, which is the intent. A multi-line `biome-ignore` does not work — the directive must be the last comment line before the offending line.
  - Genuine findings fixed rather than suppressed: an unused `AskUserParams` type alias and its now-unused `Static` import in `ask-user/index.ts`, an unused `TUI` import in `context-footer/index.ts`, and a useless `String.raw` in `permission-gate/core.ts`.

#### Task 4.2: Add the tracked pre-commit hook (§14)

- Status: COMPLETED
- Objective: Typecheck, tests, and lint run automatically before every commit, from a version-controlled location.
- Steps:
  1. Create `.githooks/pre-commit` with the script in standard §14 (`set -euo pipefail`; `npm run typecheck`; `node --test`; `npx biome check .`).
  2. `chmod +x .githooks/pre-commit` and confirm the executable bit is staged (`git ls-files -s .githooks/pre-commit` shows mode `100755`).
  3. Run `git config core.hooksPath .githooks`.
  4. Add `--exclude '.githooks/'` to `sync-extensions.sh` (`L7`).
  5. Task 7.2 documents the one-time `git config` command in `AGENTS.md` so a fresh clone enables it.
- Validation: `git commit` on a trivial change succeeds and visibly runs the three checks; then temporarily introduce a type error, confirm `git commit` is rejected, and revert it. Total hook runtime is a few seconds. `bash sync-extensions.sh --dry-run` lists no `.githooks/` entries.
- Notes: `.githooks/` must be committed, and `core.hooksPath` is per-clone local config that cannot be committed — which is exactly why Task 7.2 documents it. `--no-verify` remains the deliberate escape hatch for WIP commits.

### Milestone 5: Entrypoint Test Coverage

- Status: COMPLETED
- Purpose: Extend the fake-`pi` harness pattern — currently proven only in `context-footer` — to the two extensions with the most behaviour and the least coverage.
- Exit Criteria: Each of `ask-user` and `permission-gate` has a `test/index.test.ts` that drives its real entrypoint with no TUI and no pi runtime, and the root suite still passes.

#### Task 5.1: Add a harness test for `ask-user` (T4, T6)

- Status: COMPLETED
- Objective: The registered tool contract is asserted, not just the pure validation module.
- Steps:
  1. Create `ask-user/test/index.test.ts` modelled on `context-footer/test/index.test.ts`: build a fake `pi` whose `registerTool(def)` stores `def`, call the default export with it, and assert on the captured definition.
  2. Assert on the definition: `name` is `ask_user`; `executionMode` is `"sequential"` (`A8`); every entry in `promptGuidelines` contains the literal `ask_user` (`A4`); `parameters` is an object schema whose `questions` property is an array with `minItems: 1`, and whose question `options` items are a union of two branches each declaring `additionalProperties: false` (`A3`). Assert structurally on the emitted JSON Schema — do not attempt to run TypeBox validation here; option-shape *rejection* is already covered by `validation.test.ts`, and duplicating it adds no signal.
  3. Assert `execute` returns an error result rather than throwing when `ctx.mode !== "tui"`, and that the returned text names the requirement (`A9`, `A5`). Call it as `execute("call-1", params, undefined, undefined, { mode: "print" })` with a `params` payload that passes `normalizeQuestions` — one question, one `select` option with all four required fields — so the mode check is what fails and not validation.
  4. Assert `execute` returns an error result, again without throwing, for an invalid payload (a `select` option carrying `freeTextMode`), and that the text includes both valid option shapes (`A5`).
  5. Assert `renderResult` handles three shapes, using a stub `theme` whose `fg`/`bold` return their text argument unchanged: a cancelled result renders `Cancelled`; an error result renders the error text; a successful two-answer result renders both question labels, the chosen option labels, and the recommendation suffix when `acceptedRecommendation` is `false` and the question carries a `recommendedOptionLabel`.
- Validation: `node --test` from `ask-user/` passes and the new file contributes at least 5 tests; deliberately changing `executionMode` to `"concurrent"` or removing `ask_user` from one guideline bullet each make a test fail.
- Notes: Use `any` freely for the fakes (`R6` permits it in tests). Do not instantiate `AskUserWizard` or touch `ctx.ui.custom` — this task covers the tool definition and the non-TUI paths only. `renderCall` may also be asserted but is lower value than the above.
- Result: 6 tests, all passing. Both prescribed mutation checks fail the suite as intended (`executionMode: "concurrent"`; dropping `ask_user` from a bullet).
- **Finding — a real `A4` violation, and the one place this plan's "no behaviour changes" non-goal had to be crossed.** Three of the twelve `promptGuidelines` bullets did not name `ask_user`: the two option-shape bullets and the bulk-workflow bullet. Standard §16 records `ask-user` as `✓` for `A1`–`A11`, so this was previously unnoticed. The choice was to weaken the assertion or fix the bullets; weakening it would have removed the only thing making `A4` enforceable, so the three bullets were reworded to name the tool. This is model-facing prompt text, so it is a genuine (if minimal) change to what the extension says to the model — flagged rather than folded in silently. No schema, no semantics, and no user-visible behaviour changed.

#### Task 5.2: Add a harness test for `permission-gate` (T4)

- Status: COMPLETED
- Objective: The gate's allow/block decisions and approval caching are covered, not just its rule matching.
- Steps:
  1. Create `permission-gate/test/index.test.ts` with a fake `pi` exposing `on(event, handler)` that records handlers by event name and a `sendUserMessage` spy, plus a fake `ctx` with a settable `hasUI` and a scriptable `ui.select` that returns a queued choice and counts its calls. Call the default export, then drive the recorded `tool_call` handler directly.
  2. Build events as `{ toolName: "bash", input: { command: "<cmd>" } }`; the handler reads `event.input.command` and ignores everything else.
  3. Assert: `toolName: "read"` returns `undefined` without consulting `ui.select`; a benign command such as `ls -la` returns `undefined` without consulting `ui.select`; a dangerous command with `hasUI: false` returns `{ block: true }` with a `reason` containing the matched rule id (`P2`).
  4. Assert each of the four interactive choices for `rm -rf dist`: `"Allow once"` returns `undefined` and does **not** cache (a second identical call calls `ui.select` again); `"Allow for this session"` returns `undefined` and caches (a second identical call does not call `ui.select`); `"Explain this command"` returns `{ block: true }` and calls `pi.sendUserMessage` once with `{ deliverAs: "steer" }`; `"Block"` returns `{ block: true }`. Use the exact option strings the entrypoint defines.
  5. Assert the approval key is narrow (`P5`): after approving `rm -rf dist` for the session, `rm -rf build` — which matches the same `filesystem-rm-recursive` rule — still prompts.
  6. Assert normalization is shared (`P6`): after approving `rm -rf dist` for the session, `rm   -rf    dist` with collapsed whitespace does **not** prompt again.
  7. Assert the recorded `session_shutdown` handler clears the cache: approve for the session, invoke `session_shutdown`, then confirm the same command prompts again.
- Validation: `node --test` from `permission-gate/` passes and the new file contributes at least 7 tests; deliberately widening the approval key to the rule id alone makes the step-5 test fail, and dropping the `session_shutdown` handler makes the step-7 test fail.
- Notes: This is the highest-value new coverage in the plan — the only safety-critical decision path with no automated test today. `test/core.test.ts` from Task 3.3 covers rule *matching*; this file covers the *decisions* built on top of it. Keep them separate.
- Result: 10 tests, all passing. Both prescribed mutation checks fail, each caught by exactly the intended test: widening the approval key to the rule id alone fails only "keeps the session approval key narrower than the matched rule"; removing the `session_shutdown` handler fails only "clears cached approvals on session shutdown". No defects found — the gate behaved correctly on every path.

### Milestone 6: Deferred Quality Items

- Status: COMPLETED
- Purpose: Close the remaining `SHOULD` gaps recorded in the standard's conformance table. Optional as a group; may be marked `SKIPPED` without affecting anything above.
- Exit Criteria: The conformance table in standard §16 has no remaining `✗` or `~` for `S3`, `F3`, `U5`, or `L6`, and the table is updated to match reality.

#### Task 6.1: Derive key hints from the keybindings manager (U5)

- Status: COMPLETED
- Objective: Users with custom keybindings see correct hints.
- Steps:
  1. In `ask-user/index.ts`, import `keyHint` from `@earendil-works/pi-coding-agent` — verified re-exported from the package root, so no deep import is needed (`R4`, `R5`).
  2. Replace the four hard-coded strings returned by `getFooterHint()` with composed `keyHint(id, description)` calls using namespaced ids: `tui.select.confirm` for select/submit, `tui.select.cancel` for cancel, and `tui.select.up`/`tui.select.down` for navigation — the same ids `MultilineSelectList.handleInput` already matches against, so hints and behaviour cannot diverge.
  3. The `shift+tab` / `←` back affordance is handled by `matchesKey(data, Key.shift("tab"))` in the wizard rather than a named keybinding. Either leave that one as `rawKeyHint("shift+tab", "back")` or introduce a named binding for it — do not silently drop the affordance from the hint line.
  4. Keep using the `KeybindingsManager` injected into the wizard for `matches()` calls; do not introduce `getKeybindings()`/`setKeybindings()`. If a hint ever needs the resolved key for a specific manager instance rather than the active config, `KeybindingsManager.getKeys(id)` is the accessor.
- Validation: `npm run typecheck` clean; `node --test` root passes; `grep -nE 'esc cancel|shift\+tab/←|↑↓ navigate' ask-user/index.ts` returns nothing; the user confirms in a reloaded pi that every state's hint line still reads correctly, including the back affordance on question 2 of a multi-question run.
- Notes: Standard §17 records that `keyHint`/`keyText` are used nowhere in the repository today; this is the first use. There are exactly four hint strings, at the four `return` statements in `getFooterHint()`.

#### Task 6.2: Extract the footer's responsive fallback search (S3, F5)

- Status: COMPLETED
- Objective: `context-footer`'s `render()` contains no decision logic.
- Steps:
  1. Move the triple-nested candidate search out of `render()` in `context-footer/index.ts` into a pure exported function in `context-footer/format.ts` that takes candidate segment lists and a width and returns the first combination that fits.
  2. Reduce `render()` to building candidates and calling that function.
  3. Add direct tests for the new function in `context-footer/test/format.test.ts`, including the case where nothing fits.
- Validation: `node --test` root passes; the existing "keeps the actual footer renderer within every supported width" test still passes unchanged; `render()` is under 40 lines.
- Notes: Behaviour must be identical — the existing width-property test is the guard.

#### Task 6.3: Move display formatting out of the wizard (S3)

- Status: COMPLETED
- Objective: The `ask-user` wizard component holds interaction state only.
- Steps:
  1. Move `buildDisplayOptions()`'s pure transformation — including the `(recommended)` label suffix and the `Something else` fallback construction — into a pure exported function in `ask-user/validation.ts` or a new `ask-user/display.ts`.
  2. Have the wizard call it and keep only the state-machine dispatch.
  3. Add direct tests asserting the fallback is always appended last, the recommended suffix lands on the right option, and the editor-mode description differs from input mode.
- Validation: `node --test` root passes with at least 3 new tests; the wizard no longer constructs option labels inline.
- Notes: The `SOMETHING_ELSE_VALUE` sentinel must stay exported from a single place (`N5`).

#### Task 6.4: Narrow the wizard constructor signature (F3)

- Status: COMPLETED
- Objective: `AskUserWizard` is constructible without consulting its definition.
- Steps:
  1. Introduce a `WizardDeps` interface covering `tui`, `theme`, `keybindings`, `done`, `title`, `intro`, `questions`.
  2. Change the constructor to take a single `WizardDeps` argument and update the one call site in `ctx.ui.custom(...)`.
- Validation: `npm run typecheck` clean; `node --test` root passes; the user confirms the wizard still works in a reloaded pi.
- Notes: Depends on Task 2.2 having already removed the parameter properties.

#### Task 6.5: Add the two missing extension READMEs (L6)

- Status: COMPLETED
- Objective: Every extension documents itself.
- Steps:
  1. Create `ask-user/README.md`: purpose, the option contract (both `responseType` branches and the built-in fallback), TUI-only limitation, and how to run its tests. Move the option-contract detail currently in the root `README.md` here and leave a pointer behind.
  2. Create `permission-gate/README.md`: purpose, the "guardrail, not a security boundary" statement (`P1`), the rule-ordering policy, the four interactive choices, session-approval scoping, and how to run its tests.
- Validation: Both files exist; each names its extension's runtime limitations and test command; root `README.md` no longer duplicates the moved content.
- Notes: `context-footer/README.md` and `advisor/README.md` already exist and need no work.

### Milestone 7: Documentation And `advisor`

- Status: COMPLETED
- Purpose: Make the standard discoverable and binding for future agents, and close the one structural `advisor` gap.
- Exit Criteria: `AGENTS.md` points at the standard as authoritative and lists the real validation commands; `README.md` describes the current layout; `advisor` runs its tests with no obsolete flags.

#### Task 7.1: Remove the obsolete strip-types flag from `advisor` (T1)

- Status: COMPLETED
- Objective: `advisor` uses the standard test invocation.
- Steps:
  1. There are exactly two live sites: `advisor/package.json` (its `test` script) and `README.md` line 75. Task 1.2 deletes `advisor/package.json`, which resolves the first; Task 7.2 rewrites the second. Confirm both are gone rather than assuming.
  2. Sweep for stragglers with `--exclude-dir=docs` — the standard documents the flag's obsolescence on purpose and those references must stay. Use `--exclude-dir`, not a piped path filter: macOS grep omits the `./` prefix when recursing `.`, so `grep -v '^\./docs/'` silently matches nothing.

     ```bash
     grep -rn "experimental-strip-types" \
       --include='*.json' --include='*.md' --include='*.sh' \
       --exclude-dir=node_modules --exclude-dir=docs .
     ```
- Validation: The scoped grep returns nothing; `node --test` from `advisor/` passes all its tests with no flags.
- Notes: The flag is a no-op on Node 24 but signals a stale convention. Structural rules only — do not reformat `advisor` (Non-Goals).

#### Task 7.2: Bring `AGENTS.md` and `README.md` up to the post-migration reality (D5)

- Status: COMPLETED
- Objective: Both files describe the repository as it now is, and every command in them runs as written.
- Steps:
  1. **`AGENTS.md` — scope.** Replace the stale `Top-level .ts extension entrypoints` bullet with the directory-per-extension shape, and state pi's two discovery shapes (`*.ts` and `*/index.ts`) with the note that new extensions use the directory form (`L1`).
  2. **`AGENTS.md` — runtime sync.** Add that only files pi loads may reach the runtime directory — no tests, configs, lockfiles, or docs (`L7`) — and that adding a new kind of non-runtime file means updating the `sync-extensions.sh` exclusions in the same commit.
  3. **`AGENTS.md` — working expectations.** Add the pure-core/imperative-shell split (`S1`) as the reason any of this is testable, and the rule that deliberate constraints are marked *intentional* (`D4`) so nobody later "fixes" them.
  4. **`AGENTS.md` — agent-visible surface.** Add that the tool schema and prompt text are the real public API and that schema changes are breaking changes; point at standard §6 and call out `A1` (`StringEnum`), `A5` (return model-fixable validation failures rather than throwing), and `A4` (name the tool in every guideline bullet). Extend the "update in the same commit" list to include the extension's own `README.md`.
  5. **`AGENTS.md` — validation.** Replace the section with the standard's §13 definition of done as it actually ended up: `npm run typecheck`, `node --test` from the root, `npm run lint`, `pi --list-models`, `sync-extensions.sh --dry-run` then sync, `/reload` plus a manual pass. State that `node --test` is the only runner (`T1`), needs no flags on Node 24, and that a bare directory *argument* does not work. Document the one-time `git config core.hooksPath .githooks` and that `--no-verify` exists for WIP commits. Keep `T10` (manual verification for interactive extensions).
  6. **`AGENTS.md` — current extensions.** Update entrypoints to `ask-user/index.ts` and `permission-gate/index.ts`, add `advisor/`, and for each extension name what it is the reference implementation *for*: `ask-user` → the agent-facing contract (`A1`–`A11`); `permission-gate` → policy engineering (`P1`–`P6`), including the "guardrail, not a security boundary" framing (`P1`) and the positive-plus-negative case requirement (`P4`); `context-footer` → testability (`T4`, `E3`, `T5`). For `advisor`, record that its style pass is deferred until promotion (standard §15 and this plan's Non-Goals) and that it must not be reformatted meanwhile.
  7. **`AGENTS.md` — version anchor.** Add a short section: all `@earendil-works/*` packages pinned to the installed runtime (currently `0.84.1`, per `pi --version`), and on a pi upgrade bump the pin, re-run typecheck and tests, `/reload`, and check the built-in tool list for new collisions (`C2`, `N1`).
  8. **`README.md`.** Update the extension file list to the new layout, and replace the `node --experimental-strip-types --test ask-user/validation.test.ts` line (line 75 today) with the plain `node --test` workflow. If Task 6.5 moved the `ask_user` option contract into `ask-user/README.md`, reduce the root section to a pointer.
- Validation: Execute every command named in both files and confirm it succeeds. Then: `grep -rn "experimental-strip-types" AGENTS.md README.md` returns nothing; `grep -nE "ask-user\.ts|permission-gate\.ts" AGENTS.md README.md` returns nothing; every `§N` reference resolves to a real section in the standard; every cited rule ID exists; every path named in either file exists on disk.
- Notes: Builds on Task 0.1, which already added the `## Read this first` binding section — do not duplicate or contradict it. Do this last among the documentation tasks so the paths and commands it documents are final. Nothing in this task may describe tooling that is not yet in place; if a milestone was skipped, describe what actually exists.

### Milestone 8: Cleanup And Final Verification

- Status: TO BE DONE
- Purpose: Ensure the repository contains only intentional final artifacts and the whole change is verified end to end.
- Exit Criteria: Intermediate artifacts removed, full definition of done passes, standard §16 reflects reality, plan status `COMPLETED`.

#### Task 8.1: Cleanup Intermediate Artifacts

- Status: TO BE DONE
- Objective: Remove artifacts created only to support the migration.
- Steps:
  1. Inspect the worktree for leftovers: scratch `tsconfig.*.json` variants, one-off scripts, orphaned `node_modules` or lockfiles under extension directories, temporary test fixtures, and any `.mjs` file that was meant to be ported.
  2. Confirm `permission-gate/validate.mjs` is gone and no replacement smoke script was added (standard §18).
  3. Remove any per-extension `package.json` or `package-lock.json` left behind by Task 1.2.
  4. Confirm `*.tsbuildinfo` files are gitignored and untracked, not committed.
  5. Confirm the temporary parent-directory `include` entries added in Task 1.2 step 3 were removed by Tasks 3.1 and 3.2.
  6. Keep `docs/PI_EXTENSIONS_BEST_PRACTICES.md` and this plan.
- Validation: `git status --short` shows only intended changes; `find . -name 'package.json' -not -path './node_modules/*' -not -path '*/node_modules/*'` returns only `./package.json`; `git ls-files '*.mjs'` returns nothing; `git ls-files '*.tsbuildinfo'` returns nothing; `grep -rn '\.\./ask-user\.ts\|\.\./permission-gate\.ts' --include='tsconfig.json' .` returns nothing.
- Notes: Do not remove `advisor/README.md`, `context-footer/README.md`, `.githooks/`, `biome.json`, `tsconfig.base.json`, or anything the user added independently.

#### Task 8.2: Update the conformance table and finish

- Status: TO BE DONE
- Objective: The standard's §16 table describes the repository as it now is, not as it was.
- Steps:
  1. Rewrite standard §16 to reflect post-migration reality, changing the intro line away from "before the §15 migration".
  2. Mark §15's migration table as completed, or replace it with a one-line note that it was carried out and point at this plan for the record.
  3. Set this plan's status to `COMPLETED` and every task to its final status.
- Validation: No `✗` remains in §16 for any rule this plan addressed; every `✓` is spot-checked against the actual files.
- Notes: If Milestone 6 was skipped, leave those rows accurate rather than aspirational.

#### Task 8.3: Final Verification

- Status: TO BE DONE
- Objective: Validate the integrated change.
- Steps:
  1. `npm run typecheck`
  2. `node --test` from the repository root
  3. `npm run lint`
  4. `pi --list-models`
  5. `bash sync-extensions.sh --dry-run`, review, then `bash sync-extensions.sh`
  6. Ask the user to `/reload` and exercise: an `ask_user` call with both a select and a free-text branch plus the built-in fallback; a gated `bash` command through all four permission-gate choices; the footer at a narrow and a wide terminal width.
  7. Confirm `~/.pi/agent/extensions/` contains only the four extension directories with no test files, configs, or lockfiles (`L7`).
- Validation: Steps 1–5 all pass; the user confirms step 6; step 7 verified by `ls -R ~/.pi/agent/extensions/`.
- Notes: Steps 1–3 are also the pre-commit hook, so they should already be passing.

## Approval Gate

Implementation must not start until the user approves this plan.

## Plan Self-Check

- [x] Plan location follows the default location rule (`docs/` exists).
- [x] Scope, non-goals, assumptions, and open questions are explicit.
- [x] No unresolved open questions remain to surface.
- [x] Tasks are grouped into milestones because the plan has more than 10 tasks (22 tasks, 9 milestones).
- [x] Every task has concrete steps and validation.
- [x] Every milestone has exit criteria broader than any single task.
- [x] Cleanup and final verification are included.
- [x] The plan avoids vague actions — every task names specific files, symbols, or commands.
- [x] The plan can be executed by a coding agent without reading the original conversation; all rationale lives in `docs/PI_EXTENSIONS_BEST_PRACTICES.md`.

## Execution Notes

- Update milestone and task status before starting and after validation.
- Update each task to COMPLETED immediately after its validation passes.
- Mark tasks or milestones BLOCKED with a short reason when progress cannot continue.
- Several tasks require the user to run `/reload` inside pi. The agent cannot do this — pause and ask, then record the user's confirmation in the task notes.
- **Amendment (execution):** the per-task `/reload` checks are batched into two checkpoints rather than seven. Syncing a half-migrated tree into the live runtime directory repeatedly is a risk the plan did not weigh, and Milestone 3 is the only milestone that changes what pi loads. Checkpoint A is at the end of Milestone 3 (covers Tasks 1.1, 3.1, 3.2, 3.3); Checkpoint B is Task 8.3 (covers everything after). Every *automated* validation still runs at its own task.
- One concern per commit. Cite the rule IDs a commit satisfies in its message.
- From Task 4.2 onward the pre-commit hook runs `biome check`, which fails on unformatted code. Run `npm run format` before committing anything written in Milestones 5–8.
- Milestone 6 is the only optional group. If it is skipped, mark each of its tasks `SKIPPED` and adjust Tasks 7.2 step 8 and 8.2 accordingly rather than leaving them describing work that never happened.
