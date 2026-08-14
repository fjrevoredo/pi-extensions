#!/usr/bin/env bash
#
# The changelog and the version files must describe the same reality.
#
# CHANGELOG.md is written by agents, one entry per coherent change, and it makes three claims that
# nothing else in the tree can check: that its `Next id:` counter is the next id, that its ids are a
# gapless run, and that the version it names for an extension is the version that extension is
# actually at. All three are the kind of claim that is true on the day it is written and quietly
# false a month later — and a stale changelog looks exactly like a current one, so nothing about it
# rotting produces a symptom anyone would notice. A rule that nothing asserts drifts (§14), and this
# one would drift more quietly than any other. This script is the assertion.
#
# Three things about its design are deliberate.
#
# It never checks that a commit added an entry. Entries group many commits, so "one entry per commit"
# would be the wrong rule; enforced from a pre-commit hook it would buy a junk entry per commit rather
# than a record anybody reads. What it checks is internal consistency, which is exactly the part a
# human reader cannot verify at a glance.
#
# It reads only the working tree, never a previous revision. A diff against HEAD would assert two
# different things in the two layers — in the hook HEAD is the parent commit, in CI on a pull request
# HEAD is a merge commit whose tree is already the result — which is precisely the drift the call-site
# design in §14 exists to remove. It is also what keeps this inside the hook's ~3-second budget.
#
# An extension the changelog never names is legal; an extension it names wrongly is not. The reverse
# direction is checked separately: every extension in `git ls-files` must own a version.ts with a
# valid semver, so a new extension cannot slip in unversioned.
#
# Portability: bwk awk on macOS, mawk or gawk on ubuntu-latest. No jq, no node, no interval
# expressions in awk regexes, and no substr arithmetic across the em dash, whose byte length and
# character length disagree between the two.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="${SCRIPT_DIR}/../.."
readonly CHANGELOG="${REPO_ROOT}/CHANGELOG.md"
readonly SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

failures=0
entries=0
next_id="?"
pinned=0
versioned=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

if [[ ! -f "${CHANGELOG}" ]]; then
  printf 'FAIL: missing %s\n' "${CHANGELOG}" >&2
  exit 1
fi

# Reads <ext>/version.ts and prints the version. Prints nothing and returns non-zero on any problem;
# the caller reports it, because a fail() inside $( ) increments a counter in a subshell that is then
# thrown away.
version_of() {
  local file="${REPO_ROOT}/$1/version.ts"
  local found
  [[ -f "${file}" ]] || return 1
  found="$(sed -n 's/^export const EXTENSION_VERSION = "\(.*\)";$/\1/p' "${file}")"
  [[ "$(printf '%s' "${found}" | grep -c .)" == "1" ]] || return 2
  printf '%s' "${found}"
}

# Every structural rule about the file, in one pass. Emits `FAIL <message>` lines, one
# `LATEST <extension> <version>` line per extension named anywhere, and one `SUMMARY <entries> <next>`.
report="$(awk '
function semverCmp(a, b,   x, y, i) {
  split(a, x, ".")
  split(b, y, ".")
  for (i = 1; i <= 3; i++) {
    if ((x[i] + 0) < (y[i] + 0)) return -1
    if ((x[i] + 0) > (y[i] + 0)) return 1
  }
  return 0
}

function isSemver(v,   n, p, i) {
  n = split(v, p, ".")
  if (n != 3) return 0
  for (i = 1; i <= 3; i++)
    if (p[i] !~ /^(0|[1-9][0-9]*)$/) return 0
  return 1
}

function scope(k, tag, rest,   m, items, j, it, p, parts, name, version, joined) {
  m = split(rest, items, ",")
  joined = ""
  for (j = 1; j <= m; j++) {
    it = items[j]
    gsub(/^[ \t]+/, "", it)
    gsub(/[ \t]+$/, "", it)
    if (j == 1) joined = it
    else joined = joined ", " it
    if (it == "") {
      print "FAIL entry " tag ": the Scope list has an empty item"
      continue
    }
    if (it == "repo") {
      if (repo[k]) print "FAIL entry " tag ": names repo twice"
      repo[k] = 1
      continue
    }
    p = split(it, parts, " ")
    if (p != 2) {
      print "FAIL entry " tag ": scope item \"" it "\" is neither repo nor \"<extension> <semver>\""
      continue
    }
    name = parts[1]
    version = parts[2]
    if (name !~ /^[a-z][a-z0-9-]*$/) {
      print "FAIL entry " tag ": \"" name "\" is not a possible extension directory name"
      continue
    }
    if (!isSemver(version)) {
      print "FAIL entry " tag ": \"" version "\" is not a semver version, MAJOR.MINOR.PATCH with no leading zeros"
      continue
    }
    if (seen[k SUBSEP name]) print "FAIL entry " tag ": names " name " twice"
    seen[k SUBSEP name] = 1
    if (!(name in latest)) {
      latest[name] = version
    } else if (semverCmp(version, previous[name]) >= 0) {
      print "FAIL entry " tag ": " name " " version " is not older than " previous[name] " in entry " prevTag[name]
    }
    previous[name] = version
    prevTag[name] = tag
  }
  if (joined != rest) print "FAIL entry " tag ": the Scope items must be separated by exactly one comma and one space"
}

{ line[NR] = $0; total = NR }

END {
  if (total == 0) {
    print "FAIL the changelog is empty"
    print "SUMMARY 0 ?"
    exit
  }
  if (line[1] != "# Changelog") print "FAIL line 1 must be \"# Changelog\""

  count = 0
  counters = 0
  rules = 0
  for (i = 1; i <= total; i++) {
    if (substr(line[i], 1, 3) == "## ") { count++; start[count] = i }
    if (substr(line[i], 1, 9) == "Next id: ") { counters++; counterAt = i; counter = substr(line[i], 10) }
    if (line[i] == "---") { rules++; ruleAt = i }
  }

  if (counters != 1) print "FAIL the file needs exactly one \"Next id: \" line, and has " counters
  if (rules != 1) print "FAIL the file needs exactly one \"---\" line, closing the header, and has " rules
  if (count == 0) print "FAIL the file carries no entries"
  if (counters == 1 && count > 0 && counterAt > start[1]) print "FAIL the \"Next id: \" line must come before the first entry"
  if (rules == 1 && count > 0 && ruleAt > start[1]) print "FAIL the \"---\" line must come before the first entry"
  if (rules == 1 && counters == 1 && ruleAt < counterAt) print "FAIL the \"---\" line must come after the \"Next id: \" line"

  for (k = 1; k <= count; k++) {
    s = start[k]
    if (k < count) e = start[k + 1] - 1
    else e = total
    id[k] = -1
    n = split(line[s], f, " ")
    if (n < 4 || f[3] != "—" || f[2] !~ /^[0-9][0-9][0-9][0-9]+$/) {
      print "FAIL line " s " is not a heading of the form \"## <4-digit id> — <title>\": " line[s]
      continue
    }
    id[k] = f[2] + 0
    tag = f[2]
    title = f[4]
    for (j = 5; j <= n; j++) title = title " " f[j]
    if (line[s] != "## " tag " — " title) print "FAIL entry " tag ": the heading must be single-spaced, with no trailing space"
    if (sprintf("%04d", id[k]) != tag) print "FAIL entry " tag ": the id must be its number zero-padded to at least four digits, so " sprintf("%04d", id[k])
    if (s + 5 > e) {
      print "FAIL entry " tag ": too short. An entry needs a blank line, Date:, Scope:, a blank line, and a body"
      continue
    }
    if (line[s + 1] != "") print "FAIL entry " tag ": the line after the heading must be blank"
    if (substr(line[s + 2], 1, 6) != "Date: ") {
      print "FAIL entry " tag ": the third line must be a \"Date: \" field"
    } else {
      stamp = substr(line[s + 2], 7)
      if (stamp !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9][+-][0-9][0-9]:[0-9][0-9]$/)
        print "FAIL entry " tag ": \"" stamp "\" is not an ISO 8601 datetime with an offset, such as 2026-08-13T18:10:44+02:00"
      else day[k] = substr(stamp, 1, 10)
    }
    if (substr(line[s + 3], 1, 7) != "Scope: ") print "FAIL entry " tag ": the fourth line must be a \"Scope: \" field"
    else scope(k, tag, substr(line[s + 3], 8))
    if (line[s + 4] != "") print "FAIL entry " tag ": the line after Scope: must be blank"
    body = 0
    for (i = s + 5; i <= e; i++)
      if (line[i] != "") body++
    if (body == 0) print "FAIL entry " tag ": the body is empty"
    if (k < count && line[e] != "") print "FAIL entry " tag ": an entry must be followed by one blank line"
  }

  for (k = 1; k < count; k++) {
    if (id[k] < 0 || id[k + 1] < 0) continue
    if (id[k] != id[k + 1] + 1)
      print "FAIL the ids must descend by one with no gap and no repeat: " sprintf("%04d", id[k]) " is followed by " sprintf("%04d", id[k + 1])
    if (day[k] != "" && day[k + 1] != "" && day[k] < day[k + 1])
      print "FAIL entry " sprintf("%04d", id[k]) " is dated " day[k] ", before entry " sprintf("%04d", id[k + 1]) " at " day[k + 1] ". Entries run newest first"
  }
  if (count > 0 && id[count] >= 0 && id[count] != 1)
    print "FAIL the oldest entry must be 0001, and is " sprintf("%04d", id[count])

  want = "?"
  if (count > 0 && id[1] >= 0) want = sprintf("%04d", id[1] + 1)
  else if (count == 0) want = "0001"
  if (counters == 1 && want != "?" && counter != want)
    print "FAIL the counter reads \"Next id: " counter "\" and should read \"Next id: " want "\""

  for (name in latest) print "LATEST " name " " latest[name]
  print "SUMMARY " count " " want
}
' "${CHANGELOG}")"

while IFS= read -r record; do
  [[ -n "${record}" ]] || continue
  kind="${record%% *}"
  rest="${record#* }"
  case "${kind}" in
    FAIL)
      fail "${rest}"
      ;;
    LATEST)
      name="${rest%% *}"
      claimed="${rest##* }"
      if [[ ! -f "${REPO_ROOT}/${name}/index.ts" ]]; then
        fail "the changelog names \"${name}\", which is not an extension: there is no ${name}/index.ts"
        continue
      fi
      if ! actual="$(version_of "${name}")"; then
        fail "${name} is named in the changelog but has no readable single-line ${name}/version.ts"
        continue
      fi
      if [[ "${actual}" != "${claimed}" ]]; then
        fail "${name}/version.ts says ${actual}, and the newest changelog entry naming it says ${claimed}"
        continue
      fi
      pinned=$((pinned + 1))
      ;;
    SUMMARY)
      entries="${rest%% *}"
      next_id="${rest##* }"
      ;;
  esac
done <<<"${report}"

# The reverse direction, which nothing else covers: an extension may go unmentioned by the changelog,
# but it may not go unversioned.
while IFS= read -r name; do
  [[ -n "${name}" ]] || continue
  if ! actual="$(version_of "${name}")"; then
    fail "${name} has no ${name}/version.ts with exactly one \`export const EXTENSION_VERSION = \"…\";\` line"
    continue
  fi
  if [[ ! "${actual}" =~ ${SEMVER} ]]; then
    fail "${name}/version.ts holds \"${actual}\", which is not a semver version"
    continue
  fi
  versioned=$((versioned + 1))
done < <(cd "${REPO_ROOT}" && git ls-files '*/index.ts' | sed -e 's#/index\.ts$##' | grep -v '/' | sort -u)

if [[ "${failures}" -gt 0 ]]; then
  printf '\nchangelog: %s failure(s) over %s entry/entries\n' "${failures}" "${entries}" >&2
  exit 1
fi

printf 'changelog: %s entries, next id %s; %s versioned extension(s), %s pinned by an entry\n' \
  "${entries}" "${next_id}" "${versioned}" "${pinned}"
