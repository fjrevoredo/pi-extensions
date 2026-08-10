# ask_user

A global Pi extension that registers `ask_user`, a TUI-only clarification tool. The agent uses it to ask the user one or more single-select questions and block until they are answered.

## Behaviour

- **Synchronous and blocking.** Registered with `executionMode: "sequential"` because it waits on the user; running it concurrently with other tool calls would race.
- **Multi-question.** Questions are asked one at a time with a final review step. `shift+tab` / `←` steps back through answered questions.
- **Always escapable.** Every question carries a built-in `Something else` free-text fallback, appended last. The agent does not add one.
- **Recommendations.** A question may mark one explicit option as recommended; the result records whether the user accepted or overrode it.

## Runtime limitations

**TUI-only.** `execute` checks `ctx.mode === "tui"` and returns `Error: ask_user requires TUI mode` in any other mode. It is not usable from `pi --print` or any headless invocation.

## Option contract

Every explicit option must include `value`, `label`, `description`, and `responseType`. Use exactly one of these two shapes:

```ts
{
  value: "recommended",
  label: "Use the recommended version",
  description: "Newest compatible version.",
  responseType: "select",
}
```

```ts
{
  value: "custom",
  label: "Enter another version",
  description: "Use a custom version.",
  responseType: "freeText",
  freeTextMode: "input", // or "editor"
  freeTextPlaceholder: "Enter exact version",
}
```

The two branches are separate schema variants, each with `additionalProperties: false`, so invalid combinations are rejected by the schema rather than at runtime:

- Do not omit `responseType`.
- Do not put `freeTextMode` or `freeTextPlaceholder` on a `responseType: "select"` option.
- An explicit free-text option requires **both** free-text fields.

Validation failures the model can fix are returned as normal tool results — never thrown — and the message prints the offending field, the reason, and both valid shapes.

For bulk workflows, add an explicit fixed option such as `archive-all`. Do not infer multiple selections from a free-text response; multi-select is not part of this API.

### Option display behaviour

Long labels share one primary column. The column starts at 32 cells when the terminal permits, grows as needed up to two-fifths of the available row width, wraps labels to at most three lines, and uses `...` only when content still does not fit. The list keeps one logical option per selection and scrolls by option rather than by wrapped line.

## Module layout

| File | Responsibility |
|---|---|
| `index.ts` | Tool registration, schema, and the `AskUserWizard` component — wiring and interaction state only |
| `validation.ts` | Pure normalization and validation of the model-supplied payload |
| `display.ts` | Pure question → display-row construction (recommended suffix, `Something else` fallback) |
| `option-layout.ts` | Pure column/wrapping arithmetic, with injected text metrics |
| `multiline-select-list.ts` | Select list that wraps a label across lines while keeping one logical option per selection index |

`SOMETHING_ELSE_VALUE` is exported from `validation.ts` alone, and user input colliding with it is rejected.

## Testing

From the repository root:

```bash
node --test
```

Or just this extension's tests:

```bash
node --test ask-user/test/*.test.ts
```

`test/index.test.ts` drives the real entrypoint through a fake `pi`, so the tool schema, prompt guidelines, non-TUI paths, and `renderResult` are covered with no TUI and no pi runtime. Interactive behaviour is not — after `bash sync-extensions.sh` and `/reload`, exercise a select branch, a free-text branch, and the built-in fallback by hand.
