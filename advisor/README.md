# Read-Only Advisor

`advisor/` adds one driver-facing tool: `consult_advisor({})`.

The configured advisor can inspect bounded repository text through private `read`, `grep`, `find`, and `ls` tools. It cannot edit files, run shell commands, use the network directly, call other extensions, or contact the user. It returns one validated advice object. The driver must verify the advice and make all changes.

## Setup

Use `/advisor` in the TUI. Select an authenticated model and a supported thinking level. Pi then shows a provider-disclosure warning before it saves `getAgentDir()/advisor.json`.

Use these commands:

- `/advisor` configures and enables the global advisor.
- `/advisor on` enables the advisor for this session.
- `/advisor off` disables the advisor for this session.
- `/advisor status` shows the model, limits, counters, and last safe error.
- `/advisor config` shows the redacted global configuration.

The default configuration is disabled. The default limits are 3 consultations per agent run, 12 per session, 6 advisor turns, 8 read-only tool calls, 96 KiB context, 4,000 output tokens per advisor turn, and a 120 second deadline.

`maxAdvisorOutputTokens` is a per-turn cap, and on OpenAI-shaped APIs the advisor's reasoning is spent from it too. A turn the provider cuts off is retried once with a brevity notice; a second one reports `truncated`, whose remedy is raising this limit. Changing a default here does not reach an `advisor.json` that already exists — edit that file to pick the new value up.

A model whose id contains a slash — Vertex's `publishers/google/…` — cannot currently be configured: the stored reference must be exactly `provider/id` with one slash.

## Driver call policy

Call `consult_advisor({})` after relevant repository reads and before a consequential design, broad refactor, high-risk change, repeated failure, or non-trivial completion claim.

Do not call it for simple facts, mechanical changes, before repository orientation, after every tool call, or when no new evidence exists.

## Data and safety

The extension sends selected driver evidence and permitted repository text to the selected provider. It redacts common secret patterns and blocks default sensitive paths, user additions, and the Pi agent directory. It checks normalized and canonical paths to reduce simple symlink escapes.

This is risk reduction. It is not a security sandbox. Hard-link aliases and same-user filesystem races remain outside this policy.

Two independent layers do the work, and neither is sufficient alone. `path-policy.ts` decides which files may be opened, from the path alone; `outbound-text.ts` decides what survives from whatever was opened. Both module headers list what they intentionally do not cover.

Failures are fail-open, and that phrase is about **control, not data**. The driver receives a concise normal tool result and continues from local evidence. **No repository data or session context leaves the machine on any failure path** — every gate refuses before a provider is contacted at all. Configuring without an interactive UI is refused rather than defaulted, so the provider disclosure is never skipped. The path filter denies on every resolution error except `ENOENT`. Raw advisor reasoning, raw provider responses, and raw read output are not persisted.

## How to test it

From the repository root:

```bash
npm run typecheck
node --test                          # the whole repository
node --test 'advisor/test/*.test.ts' # this extension only
npm run lint
```

`node --test` takes no directory argument — use the glob above for one extension.

Nothing in the suite touches your real `~/.pi`: the agent directory is injected everywhere it is needed, and the fixtures write only into temporary directories. `test/path-policy.test.ts` needs no filesystem at all.

The interactive path cannot be covered by tests. After a change to `/advisor`, sync and reload, then walk it by hand: configure through the wizard and confirm it saves; `/advisor off`, trigger a consultation, confirm the exact disabled text comes back and the driver continues; `/advisor on` and confirm a real consultation returns validated advice.

## Module layout

| Module | Responsibility |
|---|---|
| `index.ts` | Wiring only: lifecycle hooks, the command and tool registrations, `pi.exec` for the git root and snapshot |
| `consultation.ts` | What stops a consultation, and what the driver is told when one is stopped |
| `slash-command.ts` | What a `/advisor` argument means, and every sentence shown to the user |
| `model-reference.ts` | The `provider/id` format: one pattern, one parse, one formatter |
| `config.ts` | Validating, reading and writing `advisor.json` |
| `contracts.ts` | The advice and configuration schemas, and the advisor's system prompt |
| `advisor-options.ts` | One thinking level translated into per-API completion options |
| `context.ts` | The pi-facing shell that gets a session out of pi |
| `evidence.ts` | What the advisor is shown, assembled from that session |
| `advisor-loop.ts` | The private read-only loop, and the turn, read and time budgets |
| `turn-policy.ts` | What one advisor turn may legally do; the private tool list |
| `path-policy.ts` | Which files may be opened, decided from the path alone |
| `path-access.ts` | The only part of the filter that touches the filesystem |
| `repository-tools.ts` | `read`, `grep`, `find`, `ls` |
| `outbound-text.ts` | Everything that caps or redacts text before it leaves the machine |

## Design notes

The rules this extension is written against, the reasoning behind the module split, and the findings from promoting it to full conformance are in [`../docs/PI_EXTENSIONS_BEST_PRACTICES.md`](../docs/PI_EXTENSIONS_BEST_PRACTICES.md). Rule IDs cited in the module headers (`P1`, `P3`, `S1`, …) refer to that document.
