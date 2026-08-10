#!/usr/bin/env bash
#
# L7 — MUST: nothing reaches the runtime directory except what pi loads.
#
# Until now L7 was verified by a human reading `sync-extensions.sh --dry-run`.
# sync-extensions.sh honours an overridden HOME, so the rule is mechanically
# checkable: sync into a throwaway HOME and assert what landed.
#
# The assertion is deliberately a POSITIVE invariant rather than a denylist. A
# denylist only catches file kinds someone already thought of, and the next
# non-runtime file is by definition one nobody has. The positive form —
# "everything here is a non-test .ts" — holds exactly today and permits L2's
# root-level `<name>.ts` extension shape.
#
# It also checks the reverse direction, which nothing else does: every
# `<ext>/index.ts` must SURVIVE the sync, so an over-broad exclusion cannot
# silently drop a whole extension.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="${SCRIPT_DIR}/../.."

# Directory names that must never appear anywhere under the runtime directory.
readonly FORBIDDEN_DIRS=(test node_modules docs .git .github .githooks)

# Runtime files that are legitimately not TypeScript. Empty today, and that is
# the point: an extension with a real runtime dependency adds its own
# `<ext>/package.json` here in the same commit, which is the review gate L7 and
# R5 both want.
ALLOWED_NON_TS=()

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

staging="$(mktemp -d)"
cleanup() { rm -rf "${staging}"; }
trap cleanup EXIT

HOME="${staging}" bash "${REPO_ROOT}/sync-extensions.sh" >/dev/null

readonly TARGET="${staging}/.pi/agent/extensions"
if [[ ! -d "${TARGET}" ]]; then
  printf 'FAIL: the sync produced no %s\n' "${TARGET}" >&2
  exit 1
fi

# 1. No non-runtime directory survived.
for name in "${FORBIDDEN_DIRS[@]}"; do
  while IFS= read -r directory; do
    [[ -n "${directory}" ]] || continue
    fail "non-runtime directory reached the runtime directory: ${directory#"${TARGET}/"}"
  done < <(find "${TARGET}" -type d -name "${name}")
done

# 2. Every file is a non-test .ts, or is explicitly allow-listed above.
while IFS= read -r file; do
  [[ -n "${file}" ]] || continue
  relative="${file#"${TARGET}/"}"

  allowed=0
  for entry in ${ALLOWED_NON_TS[@]+"${ALLOWED_NON_TS[@]}"}; do
    if [[ "${relative}" == "${entry}" ]]; then
      allowed=1
      break
    fi
  done
  [[ "${allowed}" == "1" ]] && continue

  if [[ "${relative}" == *.test.ts ]]; then
    fail "a test file reached the runtime directory: ${relative}"
  elif [[ "${relative}" != *.ts ]]; then
    fail "a non-TypeScript file reached the runtime directory: ${relative}"
  fi
done < <(find "${TARGET}" -type f)

# 3. The reverse direction: no extension was silently dropped.
while IFS= read -r entrypoint; do
  [[ -n "${entrypoint}" ]] || continue
  if [[ ! -f "${TARGET}/${entrypoint}" ]]; then
    fail "the sync dropped an extension entrypoint: ${entrypoint}"
  fi
done < <(cd "${REPO_ROOT}" && git ls-files '*/index.ts')

synced_count="$(find "${TARGET}" -type f | wc -l | tr -d ' ')"

if [[ "${failures}" -gt 0 ]]; then
  printf '\nruntime hygiene: %s failure(s) over %s synced file(s)\n' "${failures}" "${synced_count}" >&2
  exit 1
fi

printf 'runtime hygiene: %s synced file(s), all non-test TypeScript; every entrypoint survived\n' "${synced_count}"
