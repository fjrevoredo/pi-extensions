#!/usr/bin/env bash
#
# §14 — the pre-commit hook and the CI workflow must run the same checks.
#
# Both files are pure call sites: neither defines a command, both invoke npm
# scripts. That makes drift structurally unlikely but not impossible — someone
# can still add a check to one and forget the other. This repository's own
# doctrine is that a rule nothing asserts drifts (§16), and the hook had in fact
# already drifted from the scripts once, so the parity is asserted rather than
# trusted.
#
# `npm ci` is ignored: installing is CI-only, since the hook runs in a clone that
# already has node_modules. `npm test` and `npm run test` are the same script.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="${SCRIPT_DIR}/../.."
readonly HOOK="${REPO_ROOT}/.githooks/pre-commit"
readonly WORKFLOW="${REPO_ROOT}/.github/workflows/ci.yml"

for file in "${HOOK}" "${WORKFLOW}"; do
  if [[ ! -f "${file}" ]]; then
    printf 'FAIL: missing %s\n' "${file}" >&2
    exit 1
  fi
done

# Strip comments, pick out every npm invocation, reduce it to the script name.
npm_scripts_in() {
  sed -e 's/#.*$//' "$1" |
    grep -oE 'npm (run [A-Za-z][A-Za-z0-9:_-]*|test|ci)' |
    sed -e 's/^npm run //' -e 's/^npm //' |
    grep -vx 'ci' |
    sort -u
}

hook_scripts="$(npm_scripts_in "${HOOK}")"
workflow_scripts="$(npm_scripts_in "${WORKFLOW}")"

if [[ -z "${hook_scripts}" ]]; then
  printf 'FAIL: no npm script invocations found in %s\n' "${HOOK}" >&2
  exit 1
fi

if [[ "${hook_scripts}" != "${workflow_scripts}" ]]; then
  printf 'FAIL: the pre-commit hook and the CI workflow run different checks.\n\n' >&2
  diff -u \
    --label '.githooks/pre-commit' <(printf '%s\n' "${hook_scripts}") \
    --label '.github/workflows/ci.yml' <(printf '%s\n' "${workflow_scripts}") >&2 || true
  printf '\nAdd the missing check to both, or remove it from both (§14).\n' >&2
  exit 1
fi

printf 'hook and CI parity: %s\n' "$(printf '%s' "${hook_scripts}" | tr '\n' ' ')"
