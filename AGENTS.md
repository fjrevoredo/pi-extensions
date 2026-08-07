# AGENTS.md

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

- Top-level `.ts` extension entrypoints
- Supporting extension directories and modules
- Lightweight documentation for extension usage and maintenance

## Working expectations

- Keep changes focused and reviewable.
- Prefer explicit tool contracts over clever or implicit behavior.
- Preserve stateless designs unless persistent state is clearly required.
- Add concise comments where future agents would otherwise need historical context.
- Avoid compatibility layers unless the user explicitly asks for them.
- Do not leave temporary debug code, scratch files, or dead paths behind.

## Agent-visible surface

When editing an extension that exposes tools or commands, verify all of the following remain clear:

- tool/command name
- description
- parameter schema descriptions
- prompt guidance bullets
- result semantics
- any required runtime limitations, such as TUI-only behavior

If the agent-facing contract changes materially, update both:

- inline code comments near the registration/schema
- `README.md` in this repo if the change matters to maintainers

## Validation expectations

Use the smallest useful validation for the change.

Baseline check:

```bash
pi --list-models
```

Then sync to runtime and reload pi:

- run `bash sync-extensions.sh`
- run `/reload` inside pi

For interactive extensions, validate the real user flow in pi instead of relying only on static inspection.

## Current extensions

### `ask-user.ts`
- Provides the `ask_user` TUI tool.
- The tool contract is intentionally explicit and heavily documented in code.
- Validate both agent-visible schema/guidance and real TUI behavior after changes.

### `permission-gate.ts` and `permission-gate/`
- Permission-related runtime extension code.
- Be conservative when changing prompts, allow/deny behavior, or safety checks.

### `context-footer/`
- TUI-only custom footer with project metadata, agent state, and hard token-based context severity thresholds.
- Keep formatter tests and the interactive footer behavior aligned when changing layout or context display.

## Sync note

This repo is authoritative, but pi loads from `~/.pi/agent/extensions/`.
Do not assume editing only this repo changes the live runtime until `bash sync-extensions.sh` has updated the runtime copy and pi has been reloaded.
