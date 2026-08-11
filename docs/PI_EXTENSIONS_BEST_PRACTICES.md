# pi Extension Best Practices

**Status:** Ratified and self-contained. Every rule, the evidence behind it, the decisions taken, and the alternatives rejected are recorded here — §17 through §20. There is no companion document.

**Scope:** every extension in this repository — `ask-user`, `permission-gate`, `context-footer`, and `advisor`. No extension is exempt from any rule area.

## How to read the rules

| Word | Meaning |
|---|---|
| **MUST** | Either mechanically checked by the pre-commit hook (§14), or breaking it causes a runtime or safety failure. A violation is a defect. |
| **SHOULD** | The default, resolved by judgement in review. Deviating requires a one-line comment in the code saying why. |
| **MAY** | Explicitly your call; no justification needed either way. |

**These rules were derived from what this repository already did, not imported.** Most of the document propagates what one extension does best to the others; no extension here was ever a bad citizen, and the gaps that produced these rules were almost entirely *inconsistency between good extensions* rather than defects within any of them. So when a rule looks arbitrary, the reference implementation named beside it is the argument — read that code before proposing a different rule.

Strength is assigned by **enforceability**, not by importance. Some of the most important rules here are SHOULD — `S1` in particular — because nothing can verify them automatically. A MUST that nothing checks is just a SHOULD that devalues the real MUSTs.

Of 87 rules: **31 MUST, 55 SHOULD, 1 MAY**. Rules are numbered (`L1`, `T3`, …) so reviews and commit messages can cite them.

---

## 1. Repository and file layout (`L`)

**L1 — MUST: one directory per extension, entrypoint at `<name>/index.ts`.**
pi auto-discovers exactly two shapes: `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts`. Use the directory shape for everything except a genuinely single-file extension. The split shape (`foo.ts` beside a `foo/` helper directory) is not allowed — it puts the entrypoint outside the unit it belongs to, and the day anyone adds `foo/index.ts` pi discovers both and registers the extension twice.

```
context-footer/          ← the extension is the directory
  index.ts               ← entrypoint: exports default (pi: ExtensionAPI) => void
  format.ts              ← pure helpers
  test/
    format.test.ts
    index.test.ts
  tsconfig.json          ← extends ../tsconfig.base.json
  README.md
```

**L2 — MAY: keep a genuinely single-file extension as `<name>.ts` at the repository root**, with no sibling directory. The moment it needs a second module it becomes a directory (L1).

**L3 — SHOULD: the entrypoint contains wiring only.**
`index.ts` registers tools/commands/hooks, owns lifecycle subscriptions, and delegates. Policy, parsing, formatting, and validation live in sibling modules. A reviewer should be able to read `index.ts` top to bottom and see *what the extension does to pi* without reading any logic.

**L4 — SHOULD: one responsibility per module, named after that responsibility.**
`validation.ts`, `format.ts`, `option-layout.ts`, `path-policy.ts` are good. `utils.ts`, `helpers.ts`, `common.ts` are not — they attract unrelated code and destroy the test boundary.

**L5 — SHOULD: file names are `kebab-case`; tests are `<module>.test.ts` and live in `<extension>/test/`.**

**L6 — SHOULD: every extension has a `README.md`** covering purpose, agent-facing contract, runtime limitations (e.g. TUI-only), and how to test it.

**L7 — MUST: nothing reaches the runtime directory except what pi loads.**
Test files, `tsconfig*.json`, the root `package.json`, lockfiles, `biome.json`, `.githooks/`, `.github/`, `*.tsbuildinfo`, and docs must be excluded by `sync-extensions.sh`. When you add a new kind of non-runtime file, update the sync exclusions in the same commit.

Three exclusion mechanics that are easy to get wrong, all of which have already bitten this repo:

- **Glob, not literal.** `tsconfig.json` as an exclusion does *not* cover `tsconfig.base.json`. Use `tsconfig*.json`.
- **Anchor root-only exclusions with a leading slash.** `/package.json` excludes the root manifest while still letting a future extension that genuinely needs a runtime `package.json` carry its own. An unanchored `package.json` would silently strip that too.
- **A pattern containing a slash matches the path *tail*, not the transfer root** — unless it carries a leading `/`. So `--exclude '*/test/'` drops `a/test/` at *any* depth but never a `test/` directory at the repository root, which is exactly where an L2 root-level single-file extension would keep its tests. A bare `--exclude 'test/'` matches the final component anywhere and is the right form for a directory name that should never sync. Measured on both GNU rsync 3.4.3 and macOS openrsync, which agree (§17).

Verify with `bash sync-extensions.sh --dry-run` rather than reasoning about the patterns (C5). CI now asserts the outcome as well: `.github/scripts/check-runtime-hygiene.sh` syncs into a throwaway `HOME` and checks what actually landed, in both directions (§14).

---

## 2. Language, runtime, and syntax (`R`)

**R1 — MUST: TypeScript (`.ts`) for all extension code.**
No `.mjs` with JSDoc typedefs. pi loads extensions through [jiti](https://github.com/unjs/jiti), so TypeScript needs no build step, and JSDoc types are strictly weaker: they are checked by nothing unless a `tsconfig.json` covers the file, and they cannot express the discriminated unions this codebase relies on.

The strongest evidence for this rule came from typechecking `permission-gate/core.ts` for the first time: `event.toolName !== "bash"` does **not** narrow pi's `ToolCallEvent` union, because `CustomToolCallEvent.toolName` is a plain `string`. An extension-registered tool named `bash` therefore reaches the gate with an arbitrary payload — a safety-relevant hole in the one extension that most needs typechecking, invisible to any amount of JSDoc.

**R2 — MUST: erasable syntax only.**
No parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`. This matches upstream pi-mono's own rule and is a hard requirement for Node's native type stripping, which is strip-only:

```
$ node -e "import('./ask-user/multiline-select-list.ts')"
FAIL: TypeScript parameter property is not supported in strip-only mode
```

jiti *transforms* rather than strips, so parameter properties run fine in pi — but they make the module permanently untestable under `node --test`. Write the assignment out:

```ts
// Not allowed
constructor(private readonly items: Item[]) {}

// Required
private readonly items: Item[];
constructor(items: Item[]) {
	this.items = items;
}
```

Mechanically enforced by `erasableSyntaxOnly` (C3), which reports `TS1294`.

**R3 — MUST: relative imports carry the explicit `.ts` extension.**
`import { normalizeQuestions } from "./validation.ts"` — not `"./validation"`. jiti and `tsx` both resolve extensionless specifiers, but Node's ESM resolver does not:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../context-footer/format'
```

Mechanically enforced by `moduleResolution: "NodeNext"` (C3), which reports `TS2835`.

**R4 — MUST: top-level imports only.** No `await import()`, no `import("pkg").Type`. (Upstream pi-mono rule; lint-enforced.)

**R5 — MUST: import only from the four supported packages plus `node:*` built-ins.**
`@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`. Anything else is a real npm dependency: it must be declared in `dependencies` (not `devDependencies`), it needs its `node_modules/` present at runtime, and `sync-extensions.sh` excludes `node_modules/`. Adding a runtime dependency therefore requires changing the sync script in the same commit.

**R6 — MUST NOT use `any` in extension code**, except as a narrow cast on a single line at a genuinely untyped pi boundary. Test harnesses **MAY** use `any` freely for fakes — `context-footer/test/index.test.ts` is the intended shape.

**R7 — MUST: type-only imports use `import type`.** Enforced by `verbatimModuleSyntax` (C3).

---

## 3. Separation of concerns and testability (`S`)

This section is the principle the rest of the document derives from. It is SHOULD throughout only because no tool can verify it.

**S1 — SHOULD: pure core, imperative shell.**
Every extension splits into a *core* that is pure (no `pi`, no `ctx`, no TUI, no clock, no filesystem, no network) and a *shell* that does the effects. All decisions — validation, normalization, policy matching, layout arithmetic, text formatting, threshold logic — belong in the core. This is what makes `validation.ts`, `option-layout.ts`, `format.ts`, and the permission-gate rule catalogue testable; the rule generalises the existing practice.

**S2 — SHOULD: core modules never import from `@earendil-works/*`.**
The one reasonable exception is a pure measurement utility with no side effects (`visibleWidth`, `truncateToWidth`). Better still, inject it: `option-layout.ts` already does this through its `TextMetrics` interface, which is why it is testable with no pi packages present at all.

**S3 — SHOULD: UI components stay humble.**
A `Component` / wizard / footer renderer may hold interaction state and translate events into calls on the core. It must not decide *what the answer is*. Concretely: `buildDisplayOptions()` was a formatting decision living in `AskUserWizard` and now sits in `ask-user/display.ts`; `handleInput()` dispatching to a state machine is legitimately in the component, and so is `getFooterHint()`, which only composes the injected theme with resolved keybindings.

**S4 — SHOULD: express the core as data in / data out.**
Prefer functions that take a value and return a value over methods that mutate instance state. `normalizeQuestions(params) → { questions } | { error }` is the model: total, deterministic, trivially testable.

**S5 — SHOULD: return errors as values in the core; throw only at the shell boundary.**
Core functions return a discriminated result. The shell decides whether that becomes a tool error, a blocked call, or a rendered message. Do not let a core module decide the user-facing consequence of its own failure.

**S6 — SHOULD: inject non-determinism.**
Clocks, randomness, `process.env`, and `cwd` are parameters with defaults, not free variables. `formatCwd(cwd, home = process.env.HOME)` is the pattern.

---

## 4. Naming (`N`)

**N1 — SHOULD: tool names are `snake_case`** (`ask_user`, `consult_advisor`) and read as verb-object. Names stay **unprefixed** — with a handful of distinct tools there is no ambiguity for the model to resolve, and pi warns in interactive mode when an extension shadows a built-in, so a collision is loud rather than silent. Renaming a tool orphans the tool calls stored in existing sessions, so treat the name as a one-way door and check for new built-in collisions whenever pi is upgraded (C2).

**N2 — SHOULD: tool `label` is Title Case** (`Ask User`), used for TUI display only.
**N3 — SHOULD: command names are lowercase, no leading slash.**
**N4 — SHOULD: exported types are `PascalCase`; functions and variables `camelCase`; module-level constants `SCREAMING_SNAKE_CASE`.**
**N5 — SHOULD: reserved/sentinel values are visibly reserved and exported from one place** — `SOMETHING_ELSE_VALUE = "__something_else__"` is the pattern, and validation must reject user input that collides with it.
**N6 — SHOULD: names in the agent-facing schema state their own semantics.** Prefer `recommendedOptionValue` over `recommended`, `freeTextPlaceholder` over `placeholder`. Anthropic's tool-writing guidance is explicit that unambiguous parameter names materially improve model accuracy.
**N7 — SHOULD: rule/policy identifiers are stable, namespaced, kebab-case strings** (`filesystem-rm-recursive`, `git-force-push`). They appear in user-facing messages and are grep targets — treat them as API.

---

## 5. Function signatures and module API (`F`)

**F1 — SHOULD: name the default export** — `export default function askUser(pi: ExtensionAPI)` rather than an anonymous function. Stack traces and debug logs get much better.
**F2 — SHOULD: export only what is used outside the module**, and use inline `export` consistently rather than a trailing `export { … }` block.
**F3 — SHOULD: at most three positional parameters; beyond that take a single options object.**
`AskUserWizard` was the counter-example: a seven-parameter constructor, `(tui, theme, keybindings, done, title, intro, questions)`, that could not be called correctly without checking the definition and whose two adjacent `string | undefined` parameters were silently swappable. It now takes `constructor(deps: WizardDeps)`.
**F4 — SHOULD: functions that can fail return a discriminated union**, not `undefined`-means-error. `{ option } | { error }` beats `Option | undefined`.
**F5 — SHOULD: keep functions under ~40 lines and one level of abstraction.**
`context-footer`'s `render()` used to mix segment construction with a triple-nested responsive-fallback search. That search is a pure function over candidate segment lists and now lives in `format.ts` as `findFittingCombination()`; `render()` builds candidates and calls it.
**F6 — SHOULD: no exported function mutates its arguments.**

---

## 6. Agent-facing contract (`A`)

The tool schema and prompt text are the extension's real public API — the model is the caller. Treat schema changes like breaking API changes.

**A1 — MUST: use `StringEnum` from `@earendil-works/pi-ai` for string enums.** `Type.Union`/`Type.Literal` is incompatible with Google's API — this is a runtime failure on some providers, not a style preference.

**A2 — SHOULD: every schema field carries a `description`**, written as if onboarding a new teammate: the semantics, the constraint, and the failure mode.

**A3 — SHOULD: make invalid states unrepresentable in the schema.**
Use discriminated unions with `additionalProperties: false` per branch rather than optional fields that are conditionally required. `AskUserOptionSchema`'s select/freeText split is the reference implementation.

**A4 — SHOULD: every `promptGuidelines` bullet names its own tool.**
Bullets are appended flat into the shared `Guidelines` section with no grouping, so "Use this tool when…" is unresolvable. Write "Use `ask_user` when…". Assert it: the first test to check this found three of `ask-user`'s twelve bullets naming no tool at all, in the extension that is the reference implementation for this whole section.

**A5 — MUST: validation failures the model can fix are returned as normal tool results, not thrown.**
Throwing sets `isError: true` and is reserved for genuine execution failures. The result text must state what was wrong *and* show the correct shape — `optionShapeError()`, which prints the offending field, the reason, and both valid option shapes, is the standard.

**A6 — SHOULD: prompt text tells the model what *not* to retry.**
*"If ask_user returns a validation error, correct the reported option shape and do not retry the unchanged invalid payload."* Keep this class of guardrail on every validating tool.

**A7 — SHOULD: return high-signal, human-readable results.**
Summarize in `content` what the model needs to act on; put machine-readable structure in `details`. Avoid raw identifiers where a label exists.

**A8 — MUST: use `executionMode: "sequential"` for any tool that blocks on the user or mutates shared state.** Tool calls run in parallel by default; without this you get races.

**A9 — MUST: check `ctx.mode === "tui"` before TUI-only features and `ctx.hasUI` before dialogs/notifications**, and return a clear, actionable result in the unsupported mode (`"Error: ask_user requires TUI mode"`).

**A10 — SHOULD: prefer one high-leverage tool over several thin ones.** Batching related questions into a single `ask_user` call is the correct instinct and belongs in `promptGuidelines`.

**A11 — SHOULD: when the agent-facing contract changes, update in the same commit** the schema descriptions, `promptSnippet`, `promptGuidelines`, the extension `README.md`, and the root `README.md` if the contract is user-visible.

---

## 7. State and lifecycle (`E`)

**E1 — MUST NOT start background resources in the extension factory.**
No timers, watchers, sockets, or child processes at module or factory scope — factories run in invocations that never open a session (`pi --list-models`). Start them in `session_start` or on first use.

**E2 — MUST: register an idempotent `session_shutdown` handler that releases everything `session_start` acquired.**

**E3 — MUST: guard async work against session replacement.**
Keep a monotonically increasing generation counter, capture it when the async work starts, and drop the result if it no longer matches. `context-footer`'s `sessionGeneration !== generation` checks are the reference pattern; without them a slow `git status` from a torn-down session writes into the live one.

**E4 — SHOULD: keep in-memory session state genuinely session-scoped.**
`permission-gate`'s `sessionApprovals` set is correct: cleared on shutdown, keyed narrowly so one approval can never widen into a category-level bypass.

**E5 — SHOULD: persist state that must survive fork/resume in tool-result `details` or a custom entry, and reconstruct it in `session_start`.** In-memory-only state should be documented as intentionally ephemeral.

**E6 — SHOULD NOT reuse captured `pi`, `ctx`, or `sessionManager` objects across a session replacement.** Use only the `ctx` handed to the new callback.

**E7 — SHOULD: coalesce, not queue, redundant refreshes.** The in-flight/pending flag pair in `context-footer`'s `refresh()` is the pattern.

---

## 8. Safety and blast radius (`P`)

Every rule here is MUST: these are the extensions that can cause harm.

**This section binds more extensions than the obvious one.** "Can cause harm" is not "is a gate" — anything that reads repository files, ships text off the machine, or decides what a caller may touch is in scope, whatever it is called. `advisor` is the worked example: it is not a gate, so this section read as inapplicable to it, and two verified `P6` defects sat in that unexamined area the whole time. **Judging a rule area inapplicable is a claim, and it needs the same scrutiny as claiming to satisfy it** — with the extra hazard that nobody ever re-examines an area written off as not applying.

**P1 — MUST: state the security posture in the file header.**
`permission-gate` gets this right: *"It is a guardrail, not a security boundary or shell parser."* Any extension that gates, filters, or sandboxes must make the same claim explicitly. This is not defensive phrasing — pi's own `docs/security.md` states that pi "does not include a built-in sandbox" and that "extensions are TypeScript modules that run with the same permissions" as the user. An in-process gate cannot be anything but a guardrail.

**P2 — MUST: fail closed without a UI.** If a gating extension cannot prompt (`!ctx.hasUI`), it blocks and says why.

The contract this buys is worth stating as a contract, because "fail-open" in a README can otherwise be read as violating it. For `advisor`: `/advisor` refuses to configure without an interactive UI, so the provider disclosure can never be skipped; the path filter denies on every resolution error except `ENOENT`; and "fail-open" refers *only* to returning control to the driver. **No repository data or session context leaves the machine on any failure path** — every gate refuses before a provider is contacted at all. State the equivalent sentence for any extension whose failure mode looks permissive from outside.

**P3 — MUST: keep policy data ordered, commented, and in one module.**
First-match-wins ordering is behaviour, not formatting. Document the ordering policy at the top of the catalogue (broad markers like `sudo` last, so they don't mask the more useful specific reason) and record deliberate non-coverage next to the rule.

**P4 — MUST: every policy rule has at least one positive and one negative test case.** The negative cases are what prevent false-positive creep — `echo "DELETE FROM users"` → no match, `chmod 1777` → no match. Prefer a **near-miss** negative: a case that differs from the positive in exactly the dimension the rule discriminates on.

**Coverage of a catalogue has to be counted, not judged.** A 35-line test file covering 2 of 15 entries reads as coverage to a reviewer and was recorded as satisfied. Assert the count mechanically (T8) rather than confirming it by eye.

**P5 — MUST: narrow approval/caching keys.** Bind to the specific normalized input *and* the matched rule, never to a category. An extension that caches no approvals has no approval scope to get wrong — say so in its header, so the absence reads as a design property rather than as an area nobody looked at (§8).

**P6 — MUST: normalize before matching and before keying**, using the same normalizer for both.

Case is part of normalization on a case-insensitive filesystem. `advisor`'s `isProtected` compared canonical path segments against a lowercase catalogue, so a file genuinely named `Credentials.json` was admitted and read, and `additionalProtectedPaths: ["Secrets"]` against an on-disk `secrets/` protected *nothing*. **A configured protection that silently fails open is worse than an absent one, because it reads as configured.** The related requested-casing hole was closed only by an undocumented accident — `realpath` from `node:fs/promises` folds filename case where `fs.realpathSync` does not (§17) — so a security property rested on which import someone happened to choose. Normalize deliberately; do not inherit the behaviour of whichever API is in reach.

---

## 9. TUI and rendering (`U`)

**U1 — MUST: renderers never exceed the width they are given.** pi's `docs/tui.md` marks this **Critical**. Every render path is width-bounded and tested at extreme widths (T5).

**U2 — SHOULD: use `Text` with padding `(0, 0)` in `renderCall`/`renderResult`** — the default `Box` supplies padding. Use `renderShell: "self"` only when you take over framing entirely.

**U3 — SHOULD: degrade responsively by dropping whole segments, then truncating** — never emit a half-rendered segment.

**U4 — SHOULD: use theme semantic colors; never hard-code ANSI.** Where no semantic color fits, document the substitution at the call site (`context-footer` borrowing `mdHeading` for orange is the model).

**U5 — SHOULD: derive key hints from the injected `KeybindingsManager` via `keyHint()`/`keyText()`** rather than hard-coding them, so a user with custom keybindings is not shown wrong hints. `ask-user`'s `getFooterHint()` is the pattern. Note that `keyHint()` colours the key and its description itself, so do not wrap its output in another `theme.fg(...)`. An affordance matched with `matchesKey(...)` rather than a named binding has no id to resolve — use `rawKeyHint(key, description)` for it rather than dropping it from the hint line.

**U6 — MUST: propagate `focused` to the active child component.** Without it IME cursor placement breaks — a real input failure, not cosmetic.

**U7 — SHOULD: keep the default (collapsed) result view to one or two lines and put detail behind `expanded`.**

**U8 — SHOULD: use pi's built-in components before writing your own.**
`SelectList`, `SettingsList`, `BorderedLoader`, `Input`, and `Editor` cover most cases, and pi's `docs/tui.md` lists "don't rebuild them" as a Key Rule. Writing a replacement is allowed when a built-in genuinely cannot express the requirement — `ask-user`'s `MultilineSelectList` exists because `SelectList` cannot wrap a label across lines while keeping one logical option per selection index — but the reason must be stated in the module header, as it is there. Also from the same Key Rules, already satisfied across the repo: take `theme` from the `ctx.ui.custom(...)` callback rather than importing it, explicitly type the `DynamicBorder` colour callback parameter, and call `tui.requestRender()` after every state change in `handleInput`.

---

## 10. Testing (`T`)

**T1 — MUST: `node --test` is the only test command.**
No `tsx`, no `vitest`, no bespoke runners. Verified on Node 24: bare `node --test` discovers `**/*.test.ts` and strips types with no flag; a *directory argument* does not work (`node --test test/` fails to resolve); `--experimental-strip-types` is obsolete.

**T2 — MUST: `node --test` at the repository root passes.**
This is the whole-repo gate, across all four extensions. It is green; keep it green. The pre-commit hook (§14) enforces this.

**T3 — SHOULD: cover all core-module decision logic.**
Validation, policy matching, layout arithmetic, threshold logic, and formatting each get direct tests. Coverage of the shell is not expected.

**T4 — SHOULD: test the entrypoint through a fake-`pi` harness.**
`context-footer/test/index.test.ts` is the reference: build a minimal object implementing the `ExtensionAPI` surface actually used, call the default export, capture the registered handlers and the footer factory, then drive lifecycle events and assert on rendered output. It proves an entrypoint can be tested with no TUI and no pi runtime. For `ask-user` that means asserting on the registered schema, `promptGuidelines`, and `renderResult` output; for `permission-gate`, the `tool_call` handler's block/allow decisions and its session-approval caching.

**T5 — SHOULD: use property-style tests for width- or size-bounded renderers.** Loop over a range of widths (`1, 20, 40, 60, 80, 120`) and assert the invariant, rather than asserting one golden string.

**T6 — SHOULD: assert on error *messages*, not just on failure.**
`assert.match(error, /freeTextMode must be "input" or "editor"/)` — for an agent-facing tool the message *is* the contract (A5).

**T7 — SHOULD: keep tests hermetic.** No network, no git, no real filesystem writes, no `~`. Inject fakes.

**T8 — SHOULD: use table-driven tests for rule catalogues**, each row `{ input, expectedRuleId }`, including `null` expectations (P4). Add a **meta-test over the table**: iterate the catalogue itself and fail if any entry lacks both a positive and a near-miss negative case. That is what turns P4 from a rule someone confirms into a rule that cannot silently lapse when an entry is added.

**T9 — MUST: `npm run typecheck` passes, and every extension file is covered by a `tsconfig.json`.**
Bringing previously-unchecked code under `tsc` is **diagnostic, not merely corrective**: it surfaces findings, not just errors. Do it early on anything newly covered, and read what it reports as evidence about the code rather than as a list of things to silence — `R1`'s `ToolCallEvent` narrowing gap is what the first typecheck of `permission-gate/core.ts` found.
Today the `ask-user` and `permission-gate` trees — 2,211 lines, including the most intricate code in the repo — are covered by no `tsconfig.json` at all and are never typechecked. `context-footer` is the only extension that is.

**T10 — SHOULD: verify interactive flows manually in pi** after `sync-extensions.sh` + `/reload`. Automated tests do not replace this for TUI extensions; they reduce how often it has to be exhaustive. **Batch these checks.** Syncing a half-finished tree into the live runtime directory once per commit is a real risk for no benefit; a checkpoint after a milestone and one at the end is enough, while every automated check still runs per commit.

**T11 — SHOULD: prove a test can fail before trusting it green.**
A test is evidence only once you have seen it react. Four ways one can be green and assert nothing, each of which has already happened here:

- **Verify moved logic against the pre-move implementation, not against its tests.** When a refactor relocates logic, recover the original from git and run it side by side with the new one over generated inputs. Tests that moved with the code cannot detect a change they were rewritten around; this is what makes "no behaviour change" a claim rather than a hope, and it is cheap.
- **Sweep a bounded or ordered property; do not sample it.** One sample passes under the wrong order too. An assertion that evidence is redacted *before* the byte cap held under the reversed ordering, because a single sample sits inside the head or the tail intact — the failure is alignment-specific, and only a boundary sweep finds it.
- **When mutating to check sensitivity, confirm the mutation applied.** A mutation that never applied and a mutation that cannot change behaviour both look exactly like coverage. Report *never applied* as a third outcome alongside caught and escaped, and include a deliberately inert control to confirm the runner reports real escapes.
- **Anchor an assertion meant to pin a path**, or it matches the broken output just as happily. `displayPath`'s only assertion, `/data\.txt:2:needle/`, passed through a *fallback* branch that reduced every result to a bare filename; the intended code path had never executed.

---

## 11. Tooling and configuration (`C`)

The repository is a **single root workspace**. Every dependency here is dev-only — types and TypeScript — so there is nothing to install per extension. The official per-extension `package.json` pattern exists for extensions with *runtime* dependencies; adopting it here would only reintroduce the version drift it cannot prevent.

**C1 — MUST: exactly one `package.json`, at the repository root.**

```json
{
  "name": "pi-extensions",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --build",
    "format": "biome format --write .",
    "lint": "biome check ."
  }
}
```

One `npm install`, one dependency set, one place to bump on a pi upgrade. An extension that genuinely needs a runtime dependency **MAY** carry its own `package.json` with that dependency in `dependencies` — and then L7 and R5 both apply.

`"type": "module"` is load-bearing, not cosmetic. With `module: NodeNext` and `verbatimModuleSyntax` (C3), omitting it makes TypeScript treat every `.ts` file as CommonJS, and *every* file fails with `TS1287: A top-level 'export' modifier cannot be used on value declarations in a CommonJS module`. If you ever see a wall of `TS1287`, this field is missing.

**C2 — MUST: all `@earendil-works/*` packages are pinned to the exact version of the installed `pi` runtime.**
The installed runtime is **`pi 0.84.1`**, and the single root `package.json` pins every `@earendil-works/*` package to it. Exact pins, no ranges (upstream pi-mono rule). When pi is upgraded: bump the root `package.json`, re-run typecheck and tests, `/reload`, and check the built-in tool list for names that now collide with an extension tool (N1).

**`package-lock.json` is tracked, and `engines.node` is `^24`.** Pinning the seven direct dependencies is not the same as pinning what installs: the transitive tree is two orders of magnitude larger, including native binaries and the whole AWS/Google/OpenAI/Mistral surface `pi-coding-agent` pulls in, and all of it floated on every `npm install` — the drift this rule exists to prevent, one level down. CI installs with `npm ci`, which additionally fails when the manifest and the lock disagree. `engines.node` is `^24` rather than `>=24` deliberately: with `>=`, `setup-node` resolves to the newest Node available and would silently move CI off the runtime every §17 fact was measured against. It is the repository's only machine-readable Node pin; a second one in `.nvmrc` was rejected.

**C3 — MUST: each extension has a `tsconfig.json` extending the root `tsconfig.base.json`.**

```json
// tsconfig.base.json (root)
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

```json
// <extension>/tsconfig.json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "composite": true },
  "include": ["*.ts", "test/*.ts"]
}
```

```json
// tsconfig.json (root) — what `npm run typecheck` actually resolves
{
  "files": [],
  "references": [
    { "path": "./ask-user" },
    { "path": "./permission-gate" },
    { "path": "./context-footer" },
    { "path": "./advisor" }
  ]
}
```

All three files are required. `typecheck` is `tsc --build`, which needs a root project that references each extension — without it the command checks nothing. `composite: true` is what makes an extension referenceable, and it is compatible with the base's `noEmit: true`. **Add a `references` entry whenever you add an extension**, or it is silently never typechecked.

`composite` writes a `tsconfig.tsbuildinfo` beside each extension `tsconfig.json`; gitignore `*.tsbuildinfo` and exclude it from the sync (L7).

`erasableSyntaxOnly` enforces R2 (`TS1294`); `moduleResolution: NodeNext` enforces R3 (`TS2835`); `verbatimModuleSyntax` enforces R7 (`TS1484`); `allowImportingTsExtensions` permits R3's explicit extensions. Per-extension configs keep each extension independently checkable. Verified: `tsc --build` surfaces both ordinary type errors and `erasableSyntaxOnly` violations *through* references, so the root project is a real gate rather than a no-op.

This baseline was run against `context-footer` before being adopted: it reports exactly three errors, all of them the R3 violations, and nothing else. With the R3 fix applied it typechecks clean and `node --test` runs all 10 tests with no flags and no `tsx`.

**C4 — MUST: formatting matches upstream pi-mono, enforced by a checked-in Biome config.**

```json
// biome.json (root)
{
  "formatter": { "indentStyle": "tab", "indentWidth": 3, "lineWidth": 120 },
  "linter": { "rules": { "recommended": true } }
}
```

Tabs, indent width 3, line width 120 — identical to upstream, so code moves between repos without reformat noise.

Three things the installed Biome (2.5.7) forces, which the snippet above predates:

- `linter.rules.recommended: true` is **deprecated** and warns. Write `"rules": { "preset": "recommended" }` instead — same rule set, current key.
- Exclusions go in `files.includes` with `!`-prefixed entries (Biome 2.x), not `files.ignore` (1.x). Check the installed Biome's own schema before writing them.
- **`biome.json` cannot carry comments** — only `biome.jsonc` can. Adding one silently invalidates the config, at which point Biome falls back to its defaults and starts checking directories you meant to exclude. Rationale for a disabled rule therefore belongs in `AGENTS.md`, not inline.

**Nothing is excluded.** `biome.json` carries no path exemption for any extension: an extension exempted from formatting stops being comparable to the others, and the exemption outlives the reason for it. Two `recommended` rules are turned off in this repo, both deliberately: `noExplicitAny` for test files only, via an `overrides` block matching `**/test/**` and `**/*.test.ts` (R6 already permits it in fakes), and `noNonNullAssertion` repo-wide (Biome's only offered fix is `?.`, which it marks *unsafe* because it short-circuits where the assertion would throw — applying it would be a behaviour change).

**Reformat last.** Layout and language changes land before a formatting pass, or files get reformatted twice and the diffs become unreviewable. The pass must come after the last file has *moved*, not merely after the last file has been edited — a rename after the reformat drags the whole file through the diff again.

To suppress a single genuine finding in place, `// biome-ignore <rule>: <reason>` **must be the last comment line directly above the offending line**. Additional explanatory `//` lines go *above* the directive, never between it and the code — a directive separated from its target silently does nothing, and the finding stays.

**C5 — SHOULD: review `sync-extensions.sh --dry-run` whenever the file layout changes**, and update the exclusion list in the same commit (L7).

CI asserts the *outcome* of the exclusion list (§14), but that does not retire this rule. The hygiene check can only tell you the runtime directory still contains what it should; it cannot tell you whether a change you meant to make actually happened, or whether a file you expected to sync is now missing for a reason the check considers legal. Reading the dry-run is still how an **intended** change is confirmed.

**C6 — SHOULD: keep lockfiles and `node_modules/` out of the runtime directory** unless an extension has a true runtime dependency (R5).

---

## 12. Documentation and comments (`D`)

**D1 — SHOULD: open every module with a header comment stating its purpose and its boundary.**
The best existing examples state what the module is *not*: *"Keep this module independent from pi so its contract can be tested without a TUI."*

**D2 — SHOULD: comment the *why*, never the *what*.** Ordering policies, deliberate scope limits, known false-positive trade-offs, and workarounds for pi behaviour all need a comment. Restating the code does not.

**D3 — SHOULD: keep a realistic example tool call in a comment beside `registerTool`.** The commented `ask_user` example payload is genuinely useful to the next reader.

**D4 — SHOULD: mark intentional constraints as intentional.** "This extension intentionally guards `bash` only." Without the word *intentionally*, a future agent treats the gap as a bug and widens the blast radius.

**D5 — SHOULD: update the root `README.md`** when an extension is added, removed, renamed, or repurposed, and `AGENTS.md` when the working model changes.

---

## 13. Definition of done

A change to any extension is complete when all of the following pass:

1. `npm run typecheck`
2. `node --test` from the repository root — all green. This is also the **extension-load gate**: the T4 fake-`pi` harnesses call every extension's default export, so a module that cannot be imported fails here.
3. `npm run lint`
4. `bash sync-extensions.sh --dry-run` reviewed, then `bash sync-extensions.sh`
5. `/reload` in pi, then a manual pass over the changed flow (mandatory for TUI extensions). Watch for load errors here specifically: pi reports them interactively, and no non-interactive pi invocation does (§17).
6. README/AGENTS updated if the agent-facing or maintainer-facing contract moved

Steps 1–3 are also run by the pre-commit hook (§14) and by CI, so in practice only 4–6 are manual.

`pi --list-models` used to be step 4, on the assumption that it detects an extension that fails to load. It does not — measured in §17 — so it has been removed rather than left in place as a check that reassures without checking.

---

## 14. Enforcement

Enforcement is two layers: a **local pre-commit hook** for speed, and **CI** for coverage. The reason either exists rather than relying on the §13 checklist is that agents are the main contributors here, and a checklist in a document is advisory to them while a hook is not. This repository drifted three separate ways (two pi versions, two indent styles, three test conventions) under a human-protocol regime.

**A rule that nothing asserts drifts.** That is this repository's own finding, twice measured, and it is the doctrine the rest of this section applies: `A4` was recorded as satisfied while three `promptGuidelines` bullets named no tool, and `P4` while a catalogue test covered 2 of 15 entries. Both were rules a human had confirmed by reading. Whenever a rule can be turned into an assertion — a test, a hygiene check, a parity check — the assertion is worth more than the confirmation, because only one of the two survives the next change.

### Layer 1 — the pre-commit hook

Tracked in `.githooks/`, not `.git/hooks/`, so it is version-controlled and reviewable:

```bash
# .githooks/pre-commit  — enable once per clone with:
#   git config core.hooksPath .githooks
#!/usr/bin/env bash
set -euo pipefail
npm run typecheck
npm test
npm run lint
```

Measured wall-clock on this repo: ~3 seconds.

**Its honest limitation:** `core.hooksPath` is per-clone *local* config, and local config cannot be committed. A fresh clone has no hook until someone runs that command, and neither does a new agent worktree — which is to say, the hook is absent exactly where agents work. Being tracked makes the hook *reviewable by* every clone; it does not make it *run in* every clone. The hook is therefore a fast local convenience, not the gate.

`--no-verify` remains available for deliberate WIP commits.

### Layer 2 — CI

`.github/workflows/ci.yml`, one job named `checks`, on every push to `master` and every pull request. It runs the same three npm scripts as separate steps — so one run reports all three failures rather than only the first — plus two hygiene checks that only make sense in CI.

**Drift between the two layers is controlled by mechanism, not by discipline.** Neither file defines a command: the hook calls the npm scripts and so does the workflow, so there is nothing in either file to drift. `.github/scripts/check-hook-parity.sh` then asserts that they invoke the same set, because this repository's own finding is that a rule nothing asserts drifts (§16) — and the hook had in fact already drifted from the scripts once, calling `node --test` and `npx biome check .` directly.

**`.github/scripts/check-runtime-hygiene.sh` is the strongest argument for CI existing at all.** L7 is a MUST that was previously verified by a human reading a `--dry-run`. `sync-extensions.sh` honours an overridden `HOME` (§17), so the rule became mechanically checkable: sync into a throwaway `HOME`, then assert a **positive** invariant — every surviving file is a non-test `.ts`, no non-runtime directory exists, and every `<ext>/index.ts` in `git ls-files` survived.

Three properties of that check are deliberate:

- **Positive, not a denylist.** A denylist only catches file kinds someone already thought of, and the next non-runtime file is by definition one nobody has. The positive form is exhaustive by construction, and still permits L2's root-level `<name>.ts` shape.
- **`find`, not parsed `--itemize-changes`.** The itemize format is not portable between macOS openrsync and GNU rsync.
- **Both directions.** The reverse assertion — that no entrypoint was *dropped* — catches an over-broad exclusion silently deleting a whole extension, which nothing else in the repository catches.

It is CI-only because it writes a real directory tree to a real temporary `HOME`; that is fine in a disposable runner and wrong in a ~3-second pre-commit hook.

**One thing this section does not cover.** A SonarCloud GitHub App is already attached to this repository and posts a `SonarCloud Code Analysis` check on pushed commits. It is configured app-side — nothing in the tree references it — and it predates this workflow, so "enforcement is the local pre-commit hook" was never quite the whole picture. It is not part of the gate described here: the `checks` job is what this document defines, and no rule in it is asserted by SonarCloud.

**`npm run format` does not satisfy `npm run lint`.** The hook and CI both run `npm run lint`, which is `biome check` — lint rules *plus* the `organizeImports` assist. `npm run format` is `biome format --write`, which does not organize imports, so formatting a file is not enough to make the gate pass. Use `biome check --write .` when the intent is "make it conform". This was invisible while `advisor/` was excluded from Biome and surfaced the moment it was included: twelve import-order errors that no amount of formatting would fix.

**The workflow required a lockfile, and that requirement was switched off.** Every run before that ended in `startup_failure` with zero jobs created, reporting that the workflow must be pinned with `gh actions pin` — three runs in a row, which is why the file looked broken when it was not. Pinning is a real supply-chain control — `actions/checkout@v7` is a mutable ref, and pinning it to a commit is the Actions equivalent of C2's argument for committing the lockfile. It was nevertheless disabled rather than satisfied, deliberately: this is a public repository with one maintainer, CI holds no secrets (`permissions: contents: read`, and `@earendil-works/*` are on the public registry), only first-party `actions/*` are used, and pinning would require `gh` authenticated in an environment that hosts several GitHub accounts, plus a re-pin on every action major bump. Recorded because a future agent finding unpinned actions should read it as a decision, not an oversight — and because the earlier diagnosis of the same symptom was wrong: zero workflow runs was read as "Actions is disabled for the repository", when Actions was enabled the whole time and rejecting the file.

**The L7 gate has now run on GNU rsync, and it agrees with local openrsync.** That was the strongest single argument for having CI at all, and until the first green run it was the one claim CI existed to check and had not yet checked. `check-runtime-hygiene.sh` passes on `ubuntu-latest` exactly as it does on macOS: the exclusion list admits the same files and drops the same ones under both implementations, not just under the one on the developer's machine.

Branch protection on `master` requires the `checks` status. Required checks only bite on pull requests, so pushing straight to `master` makes CI a detector rather than a gate — a deliberate choice, and the CI-level analogue of the `--no-verify` escape hatch this section already accepts by name.

---

## 15. Migration plan

**Carried out**, together with the §14 hook and the deferred quality items (`U5`, `S3`/`F5`, `F3`, `L6`). §16 describes the resulting state; the findings it surfaced are recorded there, and the toolchain facts it established are in §17. The table is kept because the *sequencing rationale* — cheapest first, layout before formatting, reformat last — is the guidance for any future migration of this kind.

Four things were learned in the doing that the table does not show, and that would apply again:

- **Order matters more than the table implies.** Steps 4 and 5 (layout, language) must land before step 6 (formatting), or files get reformatted twice and the diffs become unreviewable. Equally, the formatting pass must come *after* the last file has moved, not merely after the last file has been edited.
- **Typechecking previously-unchecked code surfaces findings, not just errors.** Step 2 is worth doing early precisely because it is diagnostic: it is what revealed the `ToolCallEvent` narrowing gap in §16.
- **Batch the manual `/reload` checks.** Syncing a half-migrated tree into the live runtime directory once per step is a real risk for no benefit. One checkpoint after the layout milestone and one at the end is enough; every automated check still runs per step.
- **Verify a moved function against the original, not against its tests.** For each refactor that relocated logic, the pre-move implementation was recovered from git and run side by side with the new one over generated inputs. That is what makes "no behaviour change" a claim rather than a hope, and it is cheap.

Ratified sequence — one concern per commit, cheapest and lowest-risk first, reformat last so no file is touched twice. Each step is independently revertible; stopping part-way leaves the repo consistent.

| # | Rules | Change | Verify |
|---|---|---|---|
| 1 | C2 | Bump `context-footer` `0.80.10` → `0.84.1` | typecheck, tests, `/reload` (API drift across four minors) |
| 2 | C1, C3, T9 | Root `package.json` + `tsconfig.base.json`, per-extension `tsconfig.json`, sync exclusion for `/package.json` | `npm run typecheck` exists for the first time |
| 3 | R3, R2 | Add `.ts` to three imports, drop `tsx`, rewrite two parameter-property constructors | root `node --test` goes green |
| 4 | L1 | `ask-user/index.ts`, `permission-gate/index.ts`, tests into `test/`, update `sync-extensions.sh` | `pi --list-models`, sync, `/reload`, exercise both extensions |
| 5 | R1 | `core.mjs` → `core.ts`; `validate.mjs` → `test/core.test.ts` | tests, `/reload`, trigger one gated command |
| 6 | C4 | `biome.json` + one reformat pass | `npm run lint` |
| 7 | T4 | Fake-`pi` harness tests for `ask-user` and `permission-gate` | tests |
| 8 | — | `advisor`: drop the obsolete `--experimental-strip-types` flag | tests |
| 9 | all | `advisor` promoted to full conformance: entrypoint reduced to wiring, 2 defects fixed, 5 test files → 15, Biome adopted | typecheck, tests, lint, manual pi pass |

`validate.mjs` is retired without replacement (step 5). It guarded rule regressions — now caught earlier by `test/core.test.ts` — and a stale sync, which `rsync -a --delete` does not produce. Extension load is covered by the T4 fake-`pi` harnesses, which call every extension's default export under `node --test`.

Half of that rationale was originally wrong and has been corrected: it said extension load was covered by `pi --list-models`, which was later measured and does not detect a broken extension at all (§17). The T4 harnesses were doing the work the whole time.

---

## 16. Conformance of the current extensions

Assessed against this document as of the current working tree, **after** the §15 migration.

| Rule area | `ask-user` | `permission-gate` | `context-footer` | `advisor` |
|---|---|---|---|---|
| L1 directory layout | ✓ | ✓ | ✓ | ✓ |
| L5 tests under `test/` | ✓ | ✓ | ✓ | ✓ |
| L6 extension README | ✓ | ✓ | ✓ | ✓ |
| R1 TypeScript | ✓ | ✓ | ✓ | ✓ |
| R2 erasable syntax | ✓ | ✓ | ✓ | ✓ |
| R3 explicit `.ts` imports | ✓ | ✓ | ✓ | ✓ |
| S1 pure core | ✓ `validation.ts`, `display.ts`, `option-layout.ts` | ✓ rule catalogue | ✓ `format.ts` | ✓ `consultation.ts`, `slash-command.ts`, `turn-policy.ts`, `evidence.ts`, `path-policy.ts`, `outbound-text.ts`, `model-reference.ts` |
| S3 humble UI | ✓ display construction extracted | ✓ | ✓ fallback search extracted | n/a |
| F3 parameter count | ✓ `WizardDeps` | ✓ | ✓ | ✓ options objects throughout |
| A1–A11 agent contract | ✓ reference implementation | n/a (no tool) | n/a | ✓ |
| E1–E7 lifecycle | ✓ stateless per call | ✓ | ✓ generation guard | ✓ |
| P1–P6 safety | n/a | ✓ reference implementation | n/a | ✓ path filter + redaction (P5 n/a: no approval cache) |
| U5 key hints | ✓ derived from the keybindings manager | n/a (built-in dialog) | n/a | n/a |
| T1 `node --test` | ✓ | ✓ | ✓ | ✓ |
| T4 entrypoint harness test | ✓ | ✓ | ✓ reference implementation | ✓ |
| T9 typechecked | ✓ | ✓ | ✓ | ✓ |
| C2 pinned pi version | ✓ root `package.json` at `0.84.1` | ✓ | ✓ | ✓ |
| C4 formatting | ✓ | ✓ | ✓ | ✓ |
| D1–D5 comments | ✓ | ✓ reference implementation | ✓ | ✓ |

Whole-repo state: `npm run typecheck` clean, `node --test` **202 passing / 0 failing** from the repository root, `npm run lint` clean, one `package.json` with a tracked lockfile, one pinned pi version, and both enforcement layers running all three — the pre-commit hook locally and the `checks` job in CI, which additionally asserts L7 mechanically (§14).

Two of `advisor`'s `P` cells need a sentence rather than a tick. **`P2` is satisfied, not violated**, despite the README describing failures as fail-open: `/advisor` refuses to configure without an interactive UI, so the provider disclosure can never be skipped; the path filter denies on every resolution error except `ENOENT`; and "fail-open" refers only to returning control to the driver. **No repository data or session context leaves the machine on any failure path** — every gate refuses before a provider is contacted at all. **`P5` is genuinely `n/a`**: `advisor` caches no approvals, so there is no approval scope to get wrong.

One pre-existing limitation is recorded here because it was undocumented until the promotion: a model whose id contains a slash — Vertex's `publishers/google/…` — cannot be configured at all, because a stored model reference must match `provider/id` with exactly one slash. Widening the pattern is a behaviour change (§19) and was left alone.

`advisor` no longer has deferred rows. Promoting it took sixteen commits, and the measured before and after: the entrypoint went from 158 lines mixing wiring with policy and formatting to wiring only; the extension went from 12 modules to 15; its tests went from 5 files to 15 — one per module — and the repository suite from 71 passing to 202; two verified defects were fixed; and the Biome exemption was removed. Nothing in `biome.json` is excluded from linting or formatting any more.

No extension was ever a bad citizen — each is the reference implementation for at least one rule area, and the gaps this table used to record were almost entirely *inconsistency between good extensions* rather than defects within any of them. Most of this document propagated what one extension already did best to the others rather than importing outside ideas.

Two things the migration surfaced that no review had:

- Typechecking `permission-gate/core.ts` for the first time revealed that `event.toolName !== "bash"` does **not** narrow pi's `ToolCallEvent` union, because `CustomToolCallEvent.toolName` is a plain `string`. An extension-registered tool named `bash` therefore reaches the gate with an arbitrary payload. This is the strongest evidence for `R1` in the document.
- Asserting `A4` in a test revealed that three of `ask-user`'s twelve `promptGuidelines` bullets did not name their own tool, despite this table previously recording `A1`–`A11` as `✓`. A rule that nothing asserts drifts.

Five more from promoting `advisor`, in the same register:

- **A rule area marked `n/a` is never re-examined.** `P1`–`P6` sat as `n/a` in this table for the one extension besides `permission-gate` that can cause harm, purely because `advisor` is not a *gate*. It filters paths and redacts secrets before shipping repository text to a third-party provider, so §8 applied in full the whole time — and the two verified defects below were both `P6` violations sitting in that unexamined area. `n/a` is a claim and needs the same scrutiny as `✓`.

- **Case-sensitive matching against a case-insensitive filesystem.** `isProtected` compared canonical path segments against a lowercase catalogue, so a file genuinely named `Credentials.json` was admitted and read, and `additionalProtectedPaths: ["Secrets"]` against an on-disk `secrets/` protected *nothing*. A configured protection that silently fails open is worse than an absent one, because it reads as configured. The related requested-casing hole was closed only by an undocumented accident: `realpath` from `node:fs/promises` folds filename case where `fs.realpathSync` does not (§17), so a security property rested on which import someone happened to choose.

- **A test that passes for the wrong reason asserts nothing.** 35 lines covering 2 of 15 catalogue entries was recorded as `✓` — coverage of a catalogue has to be **counted**, and a meta-test now fails if any entry lacks both a positive and a near-miss negative case (`P4`). Worse, `displayPath`'s only assertion, `/data\.txt:2:needle/`, passed through a *fallback* branch: the root was non-canonical, so every result was reduced to a bare filename, and the assertion matched that just as happily as the intended `src/data.txt`. The intended code path had never executed. Anchor assertions that are meant to pin a path, or they pin nothing.

- **For an ordering property, one sample is never enough.** The assertion that evidence is redacted *before* the byte cap passed under the reversed ordering too, because a single sample sits inside the head or the tail intact. The failure is alignment-specific and precise: a secret straddling the cut leaves `sk_` plus fifteen characters, one short of the redactor's sixteen-character threshold, so the fragment goes unmatched and would be shipped. Sweep the boundary; do not sample it.

- **Verify the mutation applied before concluding a test is insensitive.** Every commit in the promotion was mutation-tested before its green run was trusted, and two apparent gaps turned out to be a quoting bug in the mutation script while two others were semantically inert mutations. A mutation that never applied and a mutation that cannot change behaviour both look exactly like coverage. The runner now reports *never applied* as a third outcome, and inert controls are included deliberately to confirm it reports real escapes.

---

## 17. Verified toolchain facts

Every rule resting on a claim about the toolchain was measured, not assumed. Recorded so no future agent has to re-derive them or is tempted to doubt a rule that looks like mere style. Measured on Node v24.16.0, pi 0.84.1.

**These are measurements taken against the pre-§15 tree** — the paths and counts are as they were at the time, which is what makes them evidence. The violations they record have since been fixed; §16 describes the current state.

| Claim | How it was checked | Result | Rule |
|---|---|---|---|
| Native type stripping rejects parameter properties | `node -e "import('./ask-user/multiline-select-list.ts')"` | Fails: `TypeScript parameter property is not supported in strip-only mode` | R2 |
| Node's ESM resolver rejects extensionless relative imports | `node --test context-footer/test/format.test.ts` | Fails: `ERR_MODULE_NOT_FOUND … /context-footer/format` | R3 |
| `erasableSyntaxOnly` catches parameter properties | `tsc --erasableSyntaxOnly` on a minimal repro | `TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled` | C3 → R2 |
| `moduleResolution: NodeNext` catches extensionless imports | C3 baseline against `context-footer` as-is | Exactly 3 errors, all `TS2835`, nothing else — the baseline is minimal | C3 → R3 |
| The prescribed R3 fix works end to end | Add `.ts` to 3 imports, then C3 typecheck + bare `node --test` | Typecheck clean; 10/10 tests pass with no flags and no `tsx` | R3, T1 |
| `--experimental-strip-types` is obsolete | `node --test ask-user/validation.test.ts ask-user/option-layout.test.ts` | 16/16 pass with no flag | T1 |
| **`fs/promises.realpath` folds filename case; `fs.realpathSync` does not** | Wrote `Credentials.json`, then resolved the path `credentials.json` with both | Promises API returns the on-disk `Credentials.json`; the sync API echoes the requested `credentials.json` back | `P6` |
| A bare directory argument does not work | `node --test advisor/test` | Fails to resolve; bare `node --test` and a quoted glob both work | T1 |
| pi discovers only two extension shapes | pi `docs/extensions.md`, "Extension Locations" | `*.ts` and `*/index.ts`, per scope | L1 |
| Installed runtime version | `pi --version` | `0.84.1` | C2 |
| `keyHint`/`keyText` are unused | grep across the repo | Absent; `ask-user.ts` hard-codes 4 hint strings | U5 |
| Extensions share pi's module instance | Loaded a probe extension through pi's own jiti with its real alias map, after initialising the theme in the host | Host and extension return byte-identical `keyHint()` output — the same singleton | U5, R5 |
| `tsc --build` is a real gate through references | Injected a parameter property, an `enum`, an extensionless import, a value-import of a type, and an incomplete options object | Caught as `TS1294`, `TS1294`, `TS2835`, `TS1484`, `TS2345` | C3 |
| **`pi --list-models` does not detect a broken extension** | Synced into an overridden `HOME`, replaced `advisor/index.ts` with an import of a nonexistent module, ran `pi --list-models` — with and without authentication copied in | **Exit 0, empty stderr, no diagnostic, byte-identical to the control with the extension intact** | §13 |
| `sync-extensions.sh` honours an overridden `HOME` | `HOME="$(mktemp -d)" bash sync-extensions.sh` | Populates `$HOME/.pi/agent/extensions/` correctly — which is what makes L7 mechanically checkable in CI | L7, §14 |
| rsync matches a slash-bearing pattern against the path *tail* | GNU rsync 3.4.3 and macOS openrsync over a tree of `test/`, `ext/test/`, `ext/sub/test/` | `--exclude '*/test/'` drops both nested dirs but **not** root `test/`; `--exclude 'test/'` drops all three. Both implementations agree | L7 |

The module-instance result is worth keeping in mind whenever an extension reaches for something stateful in a pi package. pi's extension loader aliases `@earendil-works/*` to its own `dist` entrypoints and calls jiti with `moduleCache: false`, which *looks* like every extension would get a private copy — in which case any module-level singleton (the theme, the keybindings manager) would be uninitialised and throw on first use. It does not: the extension resolves to the same instance the host already initialised. That is what makes `keyHint()` (U5) safe to call from an extension, and it is why R5's four supported packages can be relied on for more than pure functions. None of the 78 official examples exercise this, so it was measured rather than assumed.

Two rules exist *only* because of these measurements:

- **R2** — the `ask-user` entrypoint and `ask-user/multiline-select-list.ts` used constructor parameter properties. This was invisible in production because jiti transforms TypeScript, but it meant those two files could never be loaded by `node --test`. That is almost certainly why `MultilineSelectList` had no tests while its pure sibling `option-layout.ts` had thorough ones — and rewriting the two constructors was enough to add five, with no other change. A testability constraint disguised as a style preference.
- **R3** — `context-footer` needed the `tsx` dependency purely because `index.ts` imported `./format` extensionless. Five characters removed the dependency and turned the repo-root suite green. The tool choice was driven by an import-style accident.

---

## 18. Decisions and rejected alternatives

Recorded so these are not re-litigated. Only the decisions where the alternative was genuinely plausible are listed.

**Directory shape over the split shape (L1).** Keeping `foo.ts` beside `foo/` was on the table — zero churn, zero runtime risk. Rejected because it has no precedent in any of the 78 official examples and stays one `foo/index.ts` away from registering an extension twice.

**TypeScript over `.mjs` + JSDoc (R1).** The `.mjs` form let `permission-gate` run under bare `node` with no tooling at all, including directly against the synced global copy — genuinely useful for a safety extension. Rejected because JSDoc typedefs in a file no `tsconfig.json` covers are checked by nothing, and a safety-critical regex catalogue is exactly what you want typechecked.

**`node --test` over `tsx` and `vitest` (T1).** `tsx` tolerates extensionless imports and non-erasable syntax, so it was the permissive option; `vitest` is upstream pi-mono's own choice. Both rejected: `tsx` hides the R2/R3 constraints rather than removing them, and `vitest` is disproportionate for a repo whose tests are pure-function assertions. Zero runner dependency is the right trade here.

**Root workspace over a `package.json` per extension (C1).** The official `with-deps/` pattern was the obvious default and was initially adopted, then reversed: every dependency in this repo is dev-only, and the per-extension pattern exists for extensions with *runtime* dependencies. A single root manifest makes the C2 version drift structurally impossible instead of merely discouraged. Per-extension `tsconfig.json` files are retained so each extension stays independently checkable.

**Bare tool names over namespacing (N1).** Anthropic's guidance recommends namespacing (`asana_search`, `jira_search`), but it targets disambiguation among many similar tools; there are a handful of distinct ones here. pi warns in interactive mode when an extension shadows a built-in, so a collision is loud rather than silent, and renaming later would orphan the tool calls stored in existing sessions. Prefixing was rejected as solving a detectable problem at a permanent cost to prompt readability.

**`validate.mjs` retired with no replacement (§15 step 5).** Two substitutes were considered and rejected: a `verify-sync.mjs` importing the synced copy (ceremony for a failure mode `rsync -a --delete` does not have) and syncing the test file into the runtime directory (violates L7). What it actually guarded is now covered earlier and better: rule regressions by `test/core.test.ts`, and extension load by the T4 fake-`pi` harnesses.

The second half of that claim originally read "extension load by `pi --list-models` in §13", and was wrong: `pi --list-models` exits 0 against a deliberately broken extension (§17). The decision to retire `validate.mjs` still stands — the T4 harnesses are a strictly stronger load gate than either — but it stood on one correct reason, not two.

**`advisor` cannot configure a model whose id contains a slash.** A stored model reference must match `provider/id` with exactly one slash, so Vertex's `publishers/google/…` ids cannot be entered at all. Widening the pattern is a behaviour change (§19) and was left alone: the pattern is what keeps the parse total, the affected ids are one provider's, and no one has needed them. Recorded because the limitation was undocumented for a long time and reads like an oversight — a future agent should reopen it as a decision, not patch the regex.

**MUST assigned by enforceability, not importance (§"How to read the rules").** An earlier draft made 76% of rules MUST with zero MAY. Recalibrated so MUST means "the hook checks it, or breaking it fails at runtime". The visible cost is that `S1` — the principle this whole document derives from — is a SHOULD. That is stated openly rather than papered over, because a MUST nothing verifies devalues the ones that are real. `A1` and `A8` are MUST despite looking stylistic: `Type.Union` is a genuine runtime failure on Google's API, and non-sequential tools race.

**A pre-commit hook rather than a checklist alone (§14).** The deciding argument is that agents are the main contributors to this repository, and a document is advisory to an agent while a hook is not. This repo drifted three separate ways under a human-protocol regime.

**CI in addition to the hook, reversing the §19 non-goal.** "No CI" was justified by "enforcement is the local pre-commit hook", and that justification does not survive inspection: `core.hooksPath` is per-clone local config that cannot be committed, so the hook is absent in a fresh clone and in every new agent worktree — absent, that is, exactly where agents work. The second deciding argument is that CI makes **L7 mechanically checkable for the first time**: `sync-extensions.sh` honours an overridden `HOME` (§17), so "nothing reaches the runtime directory except what pi loads" stops being a rule verified by reading a dry-run. A rule this document calls MUST while nothing checks it is the exact failure mode §16 already recorded twice.

**Three CI steps rather than CI invoking the hook.** Calling `.githooks/pre-commit` from the workflow would guarantee parity in one line, but `set -euo pipefail` means the first failure hides the other two, and a remote run that reports one problem per push is expensive. Separate steps, each guarded with `!cancelled()`, report all three. Parity is recovered by making both files pure call sites and asserting it (§14).

Rejected, with reasons:

- **Path filters on the triggers.** They make a required status check unsatisfiable on a docs-only pull request, which blocks the merge until someone manually overrides — an absurd trade for three seconds of checks.
- **An OS matrix.** `advisor/test/path-access.test.ts` calls `symlink()`, which needs privileges on Windows; a macOS runner costs 10× to re-test what the developer's own machine covers on every commit. Useful side effect of the split: local runs exercise macOS openrsync, CI exercises GNU rsync 3.x, and the L7 exclusion list is **observed** to behave identically under both — not merely expected to (§14).
- **A Node matrix.** See §19 — Node 24's semantics are the test strategy, not a variable.
- **`npm audit`.** Every dependency is dev-only, nothing ships, and nothing processes untrusted input. A new advisory would redden CI with no code change, and a gate that fails without a change having been made is a broken gate that trains people to ignore it.
- **A dependency-update bot.** See §19 — C2 pins to the installed runtime.
- **`biome ci` instead of `biome check`.** It would differ from what the hook runs, reintroducing by hand the drift the call-site design removes.
- **A status badge.** Not because it would not render — the repository is public, so it would. There is simply no audience: one maintainer, no external contributors, and `README.md` is read by agents working in the clone rather than by anyone deciding whether to trust the build. A badge is a signal to strangers.
- **Anything that builds, versions, publishes, or deploys.** See §19.

---

## 19. Non-goals

Deliberately absent. Do not add these without a decision.

**One entry here has been reversed by a recorded decision.** "No CI" was a non-goal and is no longer: CI was added, and the reasoning is in §18 and §14. That is what "do not add these without a decision" asks for — the entry is replaced rather than quietly deleted, so the reversal is visible to whoever reads this list next.

- **No coverage percentage target.** T3 covers core decision logic and explicitly not the shell. A global percentage would push toward testing the wiring, which is where the T4 harness already does the useful work.
- **No release, publish, or deploy pipeline.** These extensions have no build artifact, no version, and one consumer; they are delivered by `rsync`. CI checks the tree and stops there.
- **No CI matrix.** One OS and one Node major. Node 24's semantics *are* the test strategy here — R2's erasable syntax and R3's explicit extensions exist because of what Node 24 does and does not do (§17) — so a matrix would test configurations the rules are not written for. `ubuntu-latest` only, pinned by `engines.node` at `^24`.
- **No dependency-update bot.** C2 requires every `@earendil-works/*` package to move with the *installed* pi runtime, and upgrading pi is a defined procedure (C2, N1), not a version bump. A bot's pull requests would always be closed unmerged.
- **No compatibility layers.** Extensions are synced wholesale and reloaded; there are no old versions to support. `prepareArguments` exists for resumed-session argument drift and is the only exception (see pi's docs).
- **No behaviour changes as part of conformance work.** The §15 migration moves, renames, and reformats. If a migration step wants to change what an extension does, that is a separate commit.

---

## 20. Sources

**pi runtime, shipped with `@earendil-works/pi-coding-agent@0.84.1`.** Authoritative in a way no third-party writing is: it is the contract the runtime implements, at the version installed. The `docs/` and `examples/` paths below are pi's own, not this repository's — read them at `node_modules/@earendil-works/pi-coding-agent/` after `npm install`.

- `docs/extensions.md` — extension locations and discovery (L1), extension styles, lifecycle events and session-replacement footguns (E-series), `ExtensionAPI`, custom tools and `StringEnum`/error-signalling requirements (A-series), custom rendering best practices (U2), error handling, mode behaviour (A9)
- `docs/tui.md` — Line Width, marked *Critical* (U1); `Focusable`/IME (U6); Key Rules (U8)
- `docs/security.md` — no built-in sandbox; extensions run with the user's full permissions (P1)
- `examples/extensions/` — 78 official examples. Every multi-file one (`plan-mode/`, `subagent/`, `sandbox/`, `doom-overlay/`, `with-deps/`) is a directory with `index.ts` (L1). `custom-footer.ts`, `question.ts`, `questionnaire.ts`, and the examples `README.md` ("Key Patterns") inform the U- and A-series.

**Upstream project conventions**

- [pi-mono `AGENTS.md`](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md) — erasable syntax only, no `any`, top-level imports only, exact dependency pins, run tests you touch (R2, R4, R6, C2)
- [pi-mono `biome.json`](https://github.com/earendil-works/pi-mono/blob/main/biome.json) — tabs, indent width 3, line width 120 (C4)

**Agent-facing tool design**

- [Anthropic — *Writing effective tools for AI agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) — unambiguous parameter naming (N6), consolidate into high-leverage tools (A10), high-signal returns over raw identifiers (A7), actionable errors over opaque codes (A5), namespacing trade-offs (N1)
- [Anthropic — *Effective context engineering for AI agents*](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**Runtime and language**

- [Node.js — Modules: TypeScript (v24)](https://nodejs.org/docs/latest-v24.x/api/typescript.html) — strip-only semantics and its constraints (R2, R3)
- [Announcing TypeScript 5.8](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/) and [`erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html) — the `erasableSyntaxOnly` + `verbatimModuleSyntax` pairing for exactly this runtime model (C3)

**Architecture and testability**

- [Gary Bernhardt — *Boundaries*](https://www.destroyallsoftware.com/talks/boundaries), *Functional Core / Imperative Shell* — "functional core: many fast unit tests; imperative shell: few integration tests" (S1)
- [Martin Fowler — *The Humble Dialog Box*](https://martinfowler.com/articles/humble-dialog-box.html) and [Humble Object](http://xunitpatterns.com/Humble%20Object.html) — Feathers' original formulation (S3)

**This repository itself** is the source for the P-series (the `permission-gate` rule catalogue), E3 (`context-footer`'s generation counter, which solves a footgun pi documents but does not solve), and T4 (`context-footer/test/index.test.ts`, which proves an entrypoint is testable with no TUI and no pi runtime).
