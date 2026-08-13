# Pi Context Footer

A global Pi extension that replaces the default interactive footer with a two-row status display:

```text
 ~/platform/orders-api  │  feature/PLAT-4821  │  +4 ~2  │  session: idempotency fix
 ◐ Running bash  │  CTX ████░░░░░░ 42% · 84k/200k  │  Sonnet · high  │  $0.041
```

## Behaviour

- **Project row:** working directory, Git branch, Git summary, and session name.
- **Agent row:** agent/tool state, graphical context meter, model/thinking level, and cumulative provider-reported session cost.
- **Context thresholds:** based on estimated tokens, not context-window percentage: green below 100k, yellow from 100k through 199,999, bold yellow from 200k through 249,999, and red at 250k and above. The displayed percentage remains the model-reported context-window percentage.
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

- Context usage comes from `ctx.getContextUsage()`. Pi estimates trailing context and can report unknown usage after compaction until the next model response.
- **The third tier is bold yellow, not orange.** Pi's theme API exposes no orange semantic color. Borrowing the warm `mdHeading` color was the original substitution and was wrong: a theme may alias `mdHeading` to the same color as `success` — the `matrix` theme aliases both to `#00FF41` — so crossing 200k tokens rendered *identically to green*, reading as the meter recovering rather than degrading. Bold is orthogonal to the palette, so bold `warning` cannot collide with another tier under any theme, and no ANSI is hard-coded (U4).
- **Read the third tier off the percentage, not the bar.** Bold is what separates it from the yellow tier, and bold on the solid `█` glyph is imperceptible in many terminals — it is legible on the percentage digits, which are rendered in the tier's style even when usage is below one cell's worth and the bar has no filled cells at all. Note also that `theme.bold()` is chalk-backed and therefore suppressed when chalk detects no color support (`NO_COLOR`, a non-TTY stdout), while `theme.fg()` writes ANSI unconditionally; in that case this tier falls back to reading as the yellow tier. Interactive TUI mode is the only mode this extension renders in, so stdout is a TTY there.
- **The top two tiers are unreachable on a model whose context window is 200k or smaller.** The thresholds are absolute token counts, intentionally — degradation tracks absolute context length, not window fraction — but pi auto-compacts above `contextWindow - reserveTokens`, which is 183,616 tokens at the default 16,384 reserve. A 200k-window session therefore never reaches the 200k or 250k thresholds and only ever shows green and yellow. Both tiers are reachable on a large-window model: on the 1.05M-window `gpt-5.6-luna` they fire at 19% and 23.8% of the bar. Treat this as a documented consequence of the absolute-token choice, not as a bug to fix by switching to percentages.
- Cost is summed from assistant-message usage across all session entries, matching Pi's default-footer accounting. Subscription-backed providers may report `$0.000`.
- Git state refreshes on session start, agent settled, and Git branch changes. It does not watch every working-tree file change continuously.
