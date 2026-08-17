# Permission Gate

A global Pi extension that intercepts `bash` tool calls and prompts before a command matching its rule catalogue runs.

## Security posture

**It is a guardrail, not a security boundary or shell parser.**

This is not defensive phrasing. Pi's own `docs/security.md` states that Pi ships no built-in sandbox and that extensions run with the same permissions as the user. An in-process gate that matches regexes against a command string can be worked around trivially by anything that wants to — obfuscation, indirection through a script, or any command shape the catalogue does not know about. Its job is to catch the destructive command you did not mean to run, not to contain one that someone means to run.

The extension **intentionally guards `bash` only**. Other tools are passed through untouched. That is a deliberate scope limit, not an oversight.

## Behaviour

For every `bash` call the gate normalizes the command, matches it against the catalogue, and:

- **No match** → the call proceeds, with no prompt.
- **Every target confined to a throwaway directory** → the matching rule is skipped and evaluation continues; see [The ephemeral-target exemption](#the-ephemeral-target-exemption).
- **Already approved this session** → the call proceeds, with no prompt.
- **No UI available** (`!ctx.hasUI`) → **blocked**, with a reason naming the matched rule. The gate fails closed: if it cannot ask, it does not allow.
- **Otherwise** → the user is prompted.

### The choices

| Choice | Effect |
|---|---|
| `Allow once` | This call proceeds. Nothing is cached — an identical command prompts again. |
| `Allow for this session` | This call proceeds and the approval is cached until the session ends. |
| `Allow this rule under <dir> for this session` | This call proceeds and the matched rule is exempted for `<dir>` and anything below it, until the session ends. **Offered only when it would do something** — see below. |
| `Explain this command` | The call is **blocked** and a steering message asks the agent to explain the command and then retry it unchanged for a fresh prompt. |
| `Block` | The call is blocked, with a reason containing the matched rule id. |

The third is conditional. It appears only when the matched rule declares a `targetScope`, the command names exactly one operand a grant could describe (absolute, at least two segments, a literal), **and** re-running the catalogue with that grant applied would let the command through. That last condition is asked rather than predicted: `sudo rm -rf /Users/me/x` has a perfectly well-formed grant which does step the removal rule aside, but `privilege-sudo` matches next and the user is prompted anyway, so the option would have promised something it does not deliver. An option that grants nothing the user can see is worse than an absent one.

The grant covers **the operand itself**, never its parent. Granting the parent would cover a whole scratch area with one prompt, which is the more useful shape and is rejected for it: approving `rm -rf ~/project/dist` would grant `~/project`, silently exempting `rm -rf ~/project/src` for the rest of the session.

## The ephemeral-target exemption

A rule may declare a `targetScope`, naming the command whose operands decide it. Such a rule is **skipped** when every invocation of that command in the whole command string is confined below a throwaway directory. `filesystem-rm-recursive`, `filesystem-rm-wildcard`, `filesystem-rmdir` and `filesystem-shred` opt in.

Skipped, not allowed: **evaluation continues with the remaining rules.** That is what keeps `sudo rm -rf /tmp/x` gated — the removal rule steps aside and `privilege-sudo` prompts instead.

The catalogued roots are `/tmp/`, `/private/tmp/`, `/var/tmp/`, `/private/var/tmp/`, `/var/folders/` and `/private/var/folders/`. A matching operand must name something *below* a root, so `rm -rf /tmp` and `rm -rf /tmp/*` stay gated: wiping every other process's scratch state is a different act from removing one's own directory under it.

### What it deliberately does not cover

Each of these is a decision, and each fails in the safe direction — an extra prompt, never a missing one. They are asserted as rows in `test/command-targets.test.ts`, so removing one is a visible behaviour change rather than a silent widening.

- **No symlink resolution, no `realpath`, no filesystem access.** `rm -rf /tmp/link-to-repo` is treated as confined to `/tmp`.
- **No variable expansion, and no trust in one either.** An operand containing `$` or a backtick is never confined. An unquoted expansion changes the shell's *operand count*, not only an operand's value: `DIR='.. /'` turns one visible operand into two, one of them `/`.
- **`$TMPDIR` is not a root.** It was catalogued in an earlier draft on the reasoning that whatever `TMPDIR` names is a temp directory by definition. It is not — `TMPDIR=/ rm -rf "$TMPDIR/etc"` picks the root inside the very string being judged. The expanded macOS value is under `/var/folders`, which *is* catalogued, so nothing is lost.
- **Root matching is case-sensitive**, so `rm -rf /TMP/x` prompts. This is the deliberate *opposite* of `advisor`'s `P6` case-folding fix, because the direction of failure is opposite: there, folding case could only widen a denial; here it would widen an *exemption*, and `/TMP/x` is the same directory as `/tmp/x` on macOS but a different one on Linux.
- **No flag arity.** A flag's separate value reads as an operand, so nothing is confined. This is why `filesystem-truncate` does not opt in: `truncate -s 0 /tmp/f` reads the `0` as an operand, and a rule that exempts `--size=0` but not `-s 0` is worse than one that exempts neither. `shred -n 3 /tmp/x` has the same shape and also stays gated; the plain `shred /tmp/x/secret` form is what the scope buys.
- **No `cwd` awareness.** A relative operand is never confined.
- **`--no-preserve-root` voids every exemption**, whatever the operands look like.

### Session approval scoping

Approvals and granted roots are cached in memory only, in two separate sets, and both are cleared on `session_shutdown`, so neither outlives the session runtime.

The approval key is deliberately narrow — `"<rule id>::<normalized command>"`. That means:

- Whitespace-only differences collapse to the same approval, because normalization runs before both matching and keying.
- A **different command** under the same rule still prompts. Approving `rm -rf dist` does not approve `rm -rf build`.
- A different rule matching a similar-looking command still prompts.

Binding to the category or the rule alone would let one approval widen into a blanket bypass, which is the failure mode this scoping exists to prevent.

A granted root is keyed `"<rule id>::root::<directory>"` for the same reason. A directory granted for `filesystem-rm-recursive` exempts nothing under `filesystem-rmdir`.

## Rule catalogue and ordering

The catalogue lives in `core.ts` and is the single source of truth. **Rule order is behaviour, not formatting** — evaluation is first-match-wins, so the first matching rule supplies the user-facing explanation. The ordering policy:

- Specific destructive actions come before broader catch-alls.
- Explanatory, user-facing rules come before generic ones.
- Broad privilege markers such as `sudo` stay late, so they do not mask the more useful underlying reason. `sudo rm -r dist` should explain the recursive removal, not merely that it used `sudo`.

Rule ids are stable, namespaced, kebab-case strings (`filesystem-rm-recursive`, `git-force-push`). They appear in user-facing messages and are grep targets — treat them as API.

Deliberate non-coverage is recorded next to the rule it belongs to. Four current examples: SQL-destructive matching is scoped to explicit DB CLI invocations so `echo "DELETE FROM users"` does not match; `chmod 777` is gated while sticky-bit `chmod 1777` is not; and `privilege-sudo` and `process-killall` keep a plain `\b` where their neighbours do not, because `ansible-playbook --sudo` and `k3s-killall.sh` are true positives.

### Command words and flags

Most command words are matched with `(?<![-\w])` rather than `\b`, because `\b` treats `-` as a word boundary — so `\brm\b` matched the `--rm` in `docker run --rm`, `\bkill\b` matched `--kill-after`, and `\bhalt\b` matched `--halt-on-error`. The class still admits `/` and `\`, so `/bin/rm -rf /` and `\rm -rf /` keep matching.

Two rules deliberately keep the plain `\b`, and one carries a second lookbehind for a hyphenated command *name* (`openrc-shutdown`). Those exclusions are asserted in `test/core.test.ts`, not merely commented, because a later pass that "makes the catalogue consistent" would disarm them while every other test stayed green.

## Module layout

| File | Responsibility |
|---|---|
| `index.ts` | Pi lifecycle hooks and the interactive approval flow |
| `core.ts` | Rule catalogue, normalization, matching, approval keys, formatting, and the throwaway-root catalogue — all the policy |
| `command-targets.ts` | Mechanism for the exemption: statement splitting, operand extraction, literal-path canonicalization, root containment. Imports nothing and knows no policy. |

`core.ts` imports `command-targets.ts` and nothing else, so the whole policy contract is still testable with no TUI, no pi runtime and no filesystem.

## Testing

From the repository root:

```bash
node --test
```

Or just this extension's tests:

```bash
node --test permission-gate/test/*.test.ts
```

- `test/core.test.ts` covers rule **matching** — 77 command cases, plus a meta-test that iterates the catalogue and fails on any rule with no positive case. Every rule needs at least one positive **and** one negative case; the negatives are what stop false-positive creep. When you add, remove, or reorder a rule, update this table in the same pass.
- `test/command-targets.test.ts` covers the exemption **mechanism** — 51 command shapes against its own representative root list. Half of them are `FAIL-OPEN GUARDS`: spellings a plausible, simpler tokenizer calls confined while the rule pattern still matches them. Flipping one of those rows to `true` is a silent `rm -rf /`, so treat them as load-bearing rather than exhaustive-looking.
- `test/index.test.ts` covers the **decisions** built on top of matching: allow, block, fail-closed, every interactive choice, approval-key and granted-root scoping, and shutdown clearing both caches.

Keep the three files separate — matching, mechanism and deciding fail in different ways.
