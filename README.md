# pi-extensions

Private source-of-truth repository for Francisco's pi extensions.

## Purpose

This repo is the canonical home for custom pi extensions that are loaded from `~/.pi/agent/extensions/` at runtime.

Current extensions:

- `ask-user.ts` — TUI clarification tool for structured user questions
- `ask-user/validation.ts` — pure `ask_user` input normalization and validation
- `permission-gate.ts` — top-level permission gate entrypoint
- `permission-gate/` — supporting modules for the permission gate extension
- `context-footer/` — two-row TUI footer with hard token-based context thresholds

## `ask_user` option contract

`ask_user` is TUI-only and presents explicit options as single-select branches. Every explicit option must include `value`, `label`, `description`, and `responseType`.

Use exactly one of these shapes:

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

Do not omit `responseType`. Do not include `freeTextMode` or `freeTextPlaceholder` on `responseType: "select"` options. Explicit free-text options require both free-text fields. The built-in `Something else` fallback is added automatically to every question.

For bulk workflows, add an explicit fixed option such as `archive-all`. Do not infer multiple selections from a free-text response; multi-select is not part of this API.

### Option display behavior

Long labels use a shared primary column. The column starts at 32 cells when the terminal permits it, grows when needed up to two-fifths of the available row width, wraps labels to at most three lines, and uses `...` only when content still does not fit. The list keeps one logical option per selection and scrolls by option rather than by wrapped line.

## Working model

- Edit extensions here first.
- Treat this repo as the authoritative version.
- Sync changes into `~/.pi/agent/extensions/` with:

  ```bash
  bash sync-extensions.sh
  ```

- Preview sync changes without modifying the runtime directory:

  ```bash
  bash sync-extensions.sh --dry-run
  ```

- Reload pi with `/reload` to pick up runtime changes.

## Expected validation

At minimum:

1. `pi --list-models` — confirms extensions still load
2. `node --experimental-strip-types --test ask-user/validation.test.ts` — runs the pure ask-user contract tests
3. `bash sync-extensions.sh` — updates the runtime extension directory
4. `/reload` inside pi — reloads the runtime
5. Run a focused manual sanity check for the changed extension

For TUI-heavy extensions like `ask-user.ts`, validate the real interaction flow in pi after reload, including explicit input/editor branches and the built-in fallback.

## Notes

- Keep extension APIs and agent-visible tool contracts explicit.
- Prefer small, reviewable changes.
- Add or update inline comments when behavior is non-obvious from code alone.
- Update this README when extensions are added, removed, renamed, or substantially repurposed.
