#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly SOURCE_DIR="${SCRIPT_DIR}"
readonly TARGET_DIR="${HOME}/.pi/agent/extensions"
readonly USAGE="usage: bash sync-extensions.sh [--dry-run]"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

sync_extensions() {
  local dry_run="$1"
  local -a rsync_args

  rsync_args=(
    -a
    --delete
    --delete-excluded
    --exclude
    '.git/'
    --exclude
    '.githooks/'
    --exclude
    '.github/'
    --exclude
    'node_modules/'
    --exclude
    'package-lock.json'
    --exclude
    '.gitignore'
    --exclude
    '*.md'
    --exclude
    'docs/'
    --exclude
    'test/'
    --exclude
    '*.test.ts'
    --exclude
    'tsconfig*.json'
    --exclude
    '/package.json'
    --exclude
    '*.tsbuildinfo'
    --exclude
    'biome.json'
    --exclude
    'AGENTS.md'
    --exclude
    'sync-extensions.sh'
    --exclude
    'sync-extensions.ps1'
  )

  if [[ "${dry_run}" == "1" ]]; then
    rsync_args+=(--dry-run --itemize-changes)
  fi

  mkdir -p "${TARGET_DIR}"
  rsync "${rsync_args[@]}" "${SOURCE_DIR}/" "${TARGET_DIR}/"
}

main() {
  local dry_run
  dry_run="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        dry_run="1"
        ;;
      -h|--help)
        printf '%s\n' "${USAGE}"
        return 0
        ;;
      *)
        die "${USAGE}"
        ;;
    esac
    shift
  done

  require_command rsync
  sync_extensions "${dry_run}"
}

main "$@"
