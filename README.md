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
- `advisor/` — configured read-only technical advisor with the `consult_advisor({})` tool

## `ask_user` option contract

`ask_user` is TUI-only and presents explicit options as single-select branches, each declaring its own `responseType`. The full contract — both option shapes, the built-in `Something else` fallback, and the option display behaviour — is documented in [`ask-user/README.md`](ask-user/README.md).

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
3. `npm --prefix advisor test && npm --prefix advisor run typecheck` — validates the advisor contract and private read-only boundary
4. `bash sync-extensions.sh` — updates the runtime extension directory
5. `/reload` inside pi — reloads the runtime
6. Run a focused manual sanity check for the changed extension

For TUI-heavy extensions like `ask-user.ts`, validate the real interaction flow in pi after reload, including explicit input/editor branches and the built-in fallback.

## Notes

- Keep extension APIs and agent-visible tool contracts explicit.
- Prefer small, reviewable changes.
- Add or update inline comments when behavior is non-obvious from code alone.
- Update this README when extensions are added, removed, renamed, or substantially repurposed.
