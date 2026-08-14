# pi-extensions

Private source-of-truth repository for Francisco's pi extensions.

## Purpose

This repo is the canonical home for custom pi extensions that are loaded from `~/.pi/agent/extensions/` at runtime.

Every extension is a directory with its entrypoint at `<name>/index.ts` and its own `README.md`:

- [`ask-user/`](ask-user/README.md) — TUI clarification tool for structured user questions
- [`permission-gate/`](permission-gate/README.md) — prompts before dangerous `bash` commands
- [`context-footer/`](context-footer/README.md) — two-row TUI footer with hard token-based context thresholds
- [`advisor/`](advisor/README.md) — configured read-only technical advisor with the `consult_advisor({})` tool

Engineering standard: [`docs/PI_EXTENSIONS_BEST_PRACTICES.md`](docs/PI_EXTENSIONS_BEST_PRACTICES.md). Change history: [`CHANGELOG.md`](CHANGELOG.md) — what changed in each extension, when, and what moved for the caller. Each extension's current version is the `EXTENSION_VERSION` in its own `version.ts`, and nowhere else (`D6`).

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

## Setup

One dependency set at the repository root:

```bash
npm install
git config core.hooksPath .githooks   # once per clone; runs the four checks below before each commit
```

## Expected validation

```bash
npm run typecheck              # tsc --build across all four extensions
node --test                    # the whole suite, and the extension-load gate
npm run lint                   # biome check .
npm run changelog              # CHANGELOG.md schema, ids, and every version.ts (D6)
bash sync-extensions.sh --dry-run   # review, then run it without --dry-run
```

`node --test` is what confirms extensions still load: the fake-`pi` harness tests call every extension's default export, so a module that cannot be imported fails there. `pi --list-models` was previously listed here for that purpose and does not do it — it exits 0 against a deliberately broken extension.

Then `/reload` inside pi and run a focused manual check of whatever changed.

`node --test` is the only test runner. It needs no flags on Node 24 and takes no directory argument — run it bare from the root, or pass a file glob such as `node --test ask-user/test/*.test.ts`.

The first four commands are also the pre-commit hook, so in practice only the last one is manual. `git commit --no-verify` skips the hook for a deliberate WIP commit — it does not skip CI.

## CI

`.github/workflows/ci.yml` runs one job, `checks`, on every push to `master` and every pull request. It re-runs the first four commands above as separate steps, so one run reports every failure rather than only the first, and adds two checks that only make sense remotely:

- `.github/scripts/check-runtime-hygiene.sh` syncs into a throwaway `HOME` and asserts that only non-test TypeScript reached the runtime directory — and that no extension entrypoint was dropped (`L7`). Run it locally any time you change the file layout.
- `.github/scripts/check-hook-parity.sh` asserts that the pre-commit hook and the workflow run the same npm scripts.

The pre-commit hook needs `git config core.hooksPath .githooks` in every clone and so is absent by default; CI is the layer that always runs. See §14 of the standard.

For TUI-heavy extensions like `ask-user`, automated tests do not replace validating the real interaction flow in pi after reload, including explicit input/editor branches and the built-in fallback.

## Notes

- Keep extension APIs and agent-visible tool contracts explicit.
- Prefer small, reviewable changes.
- Add or update inline comments when behavior is non-obvious from code alone.
- Update this README when extensions are added, removed, renamed, or substantially repurposed, and record the change in `CHANGELOG.md` (`D5`, `D7`).
