# pi-extensions

Private source-of-truth repository for Francisco's pi extensions.

## Purpose

This repo is the canonical home for custom pi extensions that are loaded from `~/.pi/agent/extensions/` at runtime.

Current extensions:

- `ask-user.ts` — TUI clarification tool for structured user questions
- `permission-gate.ts` — top-level permission gate entrypoint
- `permission-gate/` — supporting modules for the permission gate extension
- `context-footer/` — two-row TUI footer with hard token-based context thresholds

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
2. `bash sync-extensions.sh` — updates the runtime extension directory
3. `/reload` inside pi — reloads the runtime
4. Run a focused manual sanity check for the changed extension

For TUI-heavy extensions like `ask-user.ts`, prefer validating the real interaction flow in pi after reload.

## Notes

- Keep extension APIs and agent-visible tool contracts explicit.
- Prefer small, reviewable changes.
- Add or update inline comments when behavior is non-obvious from code alone.
- Update this README when extensions are added, removed, renamed, or substantially repurposed.
