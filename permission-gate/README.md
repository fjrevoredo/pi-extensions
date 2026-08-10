# Permission Gate

A global Pi extension that intercepts `bash` tool calls and prompts before a command matching its rule catalogue runs.

## Security posture

**It is a guardrail, not a security boundary or shell parser.**

This is not defensive phrasing. Pi's own `docs/security.md` states that Pi ships no built-in sandbox and that extensions run with the same permissions as the user. An in-process gate that matches regexes against a command string can be worked around trivially by anything that wants to — obfuscation, indirection through a script, or any command shape the catalogue does not know about. Its job is to catch the destructive command you did not mean to run, not to contain one that someone means to run.

The extension **intentionally guards `bash` only**. Other tools are passed through untouched. That is a deliberate scope limit, not an oversight.

## Behaviour

For every `bash` call the gate normalizes the command, matches it against the catalogue, and:

- **No match** → the call proceeds, with no prompt.
- **Already approved this session** → the call proceeds, with no prompt.
- **No UI available** (`!ctx.hasUI`) → **blocked**, with a reason naming the matched rule. The gate fails closed: if it cannot ask, it does not allow.
- **Otherwise** → the user is prompted with four choices.

### The four choices

| Choice | Effect |
|---|---|
| `Allow once` | This call proceeds. Nothing is cached — an identical command prompts again. |
| `Allow for this session` | This call proceeds and the approval is cached until the session ends. |
| `Explain this command` | The call is **blocked** and a steering message asks the agent to explain the command and then retry it unchanged for a fresh prompt. |
| `Block` | The call is blocked, with a reason containing the matched rule id. |

### Session approval scoping

Approvals are cached in memory only and cleared on `session_shutdown`, so they never outlive the session runtime.

The approval key is deliberately narrow — `"<rule id>::<normalized command>"`. That means:

- Whitespace-only differences collapse to the same approval, because normalization runs before both matching and keying.
- A **different command** under the same rule still prompts. Approving `rm -rf dist` does not approve `rm -rf build`.
- A different rule matching a similar-looking command still prompts.

Binding to the category or the rule alone would let one approval widen into a blanket bypass, which is the failure mode this scoping exists to prevent.

## Rule catalogue and ordering

The catalogue lives in `core.ts` and is the single source of truth. **Rule order is behaviour, not formatting** — evaluation is first-match-wins, so the first matching rule supplies the user-facing explanation. The ordering policy:

- Specific destructive actions come before broader catch-alls.
- Explanatory, user-facing rules come before generic ones.
- Broad privilege markers such as `sudo` stay late, so they do not mask the more useful underlying reason. `sudo rm -r dist` should explain the recursive removal, not merely that it used `sudo`.

Rule ids are stable, namespaced, kebab-case strings (`filesystem-rm-recursive`, `git-force-push`). They appear in user-facing messages and are grep targets — treat them as API.

Deliberate non-coverage is recorded next to the rule it belongs to. Two current examples: SQL-destructive matching is scoped to explicit DB CLI invocations so `echo "DELETE FROM users"` does not match, and `chmod 777` is gated while sticky-bit `chmod 1777` is not.

## Module layout

| File | Responsibility |
|---|---|
| `index.ts` | Pi lifecycle hooks and the interactive approval flow |
| `core.ts` | Rule catalogue, normalization, matching, approval keys, formatting — imports nothing |

## Testing

From the repository root:

```bash
node --test
```

Or just this extension's tests:

```bash
node --test permission-gate/test/*.test.ts
```

- `test/core.test.ts` covers rule **matching** — 43 command cases. Every rule needs at least one positive **and** one negative case; the negatives are what stop false-positive creep. When you add, remove, or reorder a rule, update this table in the same pass.
- `test/index.test.ts` covers the **decisions** built on top of matching: allow, block, fail-closed, all four interactive choices, approval-key scoping, and shutdown clearing the cache.

Keep the two files separate — matching and deciding fail in different ways.
