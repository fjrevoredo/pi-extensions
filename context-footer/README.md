# Pi Context Footer

A global Pi extension that replaces the default interactive footer with a two-row status display:

```text
 ~/platform/orders-api  │  feature/PLAT-4821  │  +4 ~2  │  session: idempotency fix
 ◐ Running bash  │  CTX ████░░░░░░ 42% · 84k/200k  │  Sonnet · high  │  $0.041
```

## Behaviour

- **Project row:** working directory, Git branch, Git summary, and session name.
- **Agent row:** agent/tool state, graphical context meter, model/thinking level, and cumulative provider-reported session cost.
- **Context thresholds:** based on estimated tokens, not context-window percentage: green below 100k, yellow from 100k through 199,999, orange from 200k through 249,999, and red at 250k and above. The displayed percentage remains the model-reported context-window percentage.
- **Unknown context:** shows `CTX ?????????? ?%` when Pi has no current usage estimate, including immediately after compaction.
- **Responsive layout:** drops less important fields as terminal width decreases. It never emits a line wider than the width Pi supplies.

Git summary markers are `+` staged paths, `~` modified paths, `?` untracked paths, and `!` conflicted paths. A path with both staged and working-tree changes is counted in both `+` and `~`.

## Installation and reload

This directory is auto-discovered because its entry point is:

```text
~/.pi/agent/extensions/context-footer/index.ts
```

Restart Pi to load it, or use `/reload` after editing its files.

The extension only changes interactive TUI mode. To use Pi's default footer for a run, start it without extensions:

```bash
pi --no-extensions
```

## Development

```bash
cd ~/.pi/agent/extensions/context-footer
npm install
npm test
npm run typecheck
```

The extension intentionally owns Pi's single custom-footer slot. It does not compose with another extension that calls `ctx.ui.setFooter()`.

## Limitations

- Context usage comes from `ctx.getContextUsage()`. Pi estimates trailing context and can report unknown usage after compaction until the next model response. Pi's theme API does not expose an orange semantic color, so the orange tier uses the theme's warm `mdHeading` color.
- Cost is summed from assistant-message usage across all session entries, matching Pi's default-footer accounting. Subscription-backed providers may report `$0.000`.
- Git state refreshes on session start, agent settled, and Git branch changes. It does not watch every working-tree file change continuously.
