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

The default configuration is disabled. The default limits are 3 consultations per agent run, 12 per session, 6 advisor turns, 8 read-only tool calls, 96 KiB context, 1,600 output tokens per advisor turn, and a 120 second deadline.

## Driver call policy

Call `consult_advisor({})` after relevant repository reads and before a consequential design, broad refactor, high-risk change, repeated failure, or non-trivial completion claim.

Do not call it for simple facts, mechanical changes, before repository orientation, after every tool call, or when no new evidence exists.

## Data and safety

The extension sends selected driver evidence and permitted repository text to the selected provider. It redacts common secret patterns and blocks default sensitive paths, user additions, and the Pi agent directory. It checks normalized and canonical paths to reduce simple symlink escapes.

This is risk reduction. It is not a security sandbox. Hard-link aliases and same-user filesystem races remain outside this policy.

Failures are fail-open. The driver receives a concise normal tool result and must continue from local evidence. Raw advisor reasoning, raw provider responses, and raw read output are not persisted.

See `../ADVISOR_EXTENSION_RESEARCH.md` for design rationale.
