/**
 * Rule-matching coverage for the permission-gate policy catalogue.
 *
 * This file replaces the former `validate.mjs` smoke script and keeps its case table
 * verbatim. The negative expectations are the point of the table: they are what stops
 * false-positive creep as rules are added (P4).
 *
 * The block/allow *decisions* built on top of this matching live in `test/index.test.ts`.
 * Keep the two separate.
 *
 * When adding or reordering rules in core.ts, update this file in the same pass.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	createSessionApprovalKey,
	evaluateDangerousCommand,
	normalizeCommand,
	PERMISSION_GATE_RULES,
} from "../core.ts";

interface RuleCase {
	command: string;
	expectedRuleId: string | null;
	/**
	 * Which rule this row is the near-miss negative *for* (P4). Only meaningful on rows with
	 * `expectedRuleId: null`, and only asserted for the rules in `FLAG_POSITION_NARROWED_RULES`
	 * below — a rule narrowed to exclude a flag spelling is exactly the kind that a later
	 * "simplification" re-widens, and the negative row is the only thing that would notice.
	 */
	nearMissFor?: string;
}

/**
 * Rules matched with `(?<![-\w])` instead of `\b` **and** for which a real command spells the
 * command word inside a flag. Those are the rows that must never rot: each needs a positive case
 * and a tagged near-miss negative, and the meta-test below asserts both.
 *
 * `filesystem-rmdir`, `filesystem-shred` and `process-pkill` carry the same prefix but are absent
 * here on purpose — no real command takes a `--rmdir`, `--shred` or `--pkill` flag, so there is no
 * honest near-miss to pin and a made-up one would assert nothing about the world.
 *
 * `privilege-sudo` and `process-killall` are absent because they deliberately keep a plain `\b`;
 * that exclusion is asserted separately, since it is one careless edit from disappearing.
 */
const FLAG_POSITION_NARROWED_RULES = [
	"filesystem-rm-recursive",
	"filesystem-rm-wildcard",
	"process-kill",
	"privilege-su",
	"system-shutdown",
] as const;

// Ordered roughly by rule group so future diffs stay readable.
const CASES: readonly RuleCase[] = [
	{ command: "rm -rf dist", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "rm -r dist", expectedRuleId: "filesystem-rm-recursive" },
	// The flag letter is not always first, and the pattern's leading class excludes it so the
	// match is unambiguous (and linear). Both facts are invisible to `-rf`, so pin them here:
	// a class narrowed the wrong way still passes every case above while missing these.
	{ command: "rm -fr dist", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "rm -iRv dist", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "rm -i dist", expectedRuleId: null },
	// A path-qualified or backslash-escaped command word is the same removal by another spelling,
	// and the flag-position exclusion must not reject either — its class excludes `-` and word
	// characters only. These are the rows that would catch a class widened to `[^\w/]` or similar.
	{ command: "/bin/rm -rf dist", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "\\rm -rf dist", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "xargs rm -rf", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "find . -exec rm -rf {} +", expectedRuleId: "filesystem-rm-recursive" },
	{ command: "docker run --rm alpine true", expectedRuleId: null, nearMissFor: "filesystem-rm-recursive" },
	{ command: "rm src/*", expectedRuleId: "filesystem-rm-wildcard" },
	{
		command: "docker run --rm -v /d:/d img duckdb -c \"select count(*) from read_parquet('/d/x')\"",
		expectedRuleId: null,
		nearMissFor: "filesystem-rm-wildcard",
	},
	{ command: "rmdir old-dir", expectedRuleId: "filesystem-rmdir" },
	{ command: "shred secrets.txt", expectedRuleId: "filesystem-shred" },
	{ command: "echo nope > /etc/hosts", expectedRuleId: "filesystem-sensitive-redirect" },
	{ command: "echo ok > /tmp/out.txt", expectedRuleId: null },
	{ command: "echo ok >> /var/tmp/out.txt", expectedRuleId: null },
	{ command: "echo hi > /dev/null", expectedRuleId: null },
	{ command: "truncate -s 0 /tmp/file", expectedRuleId: "filesystem-truncate" },
	{ command: "kill 1234", expectedRuleId: "process-kill" },
	{ command: "timeout --kill-after=5 5 npm test", expectedRuleId: null, nearMissFor: "process-kill" },
	{ command: "killall node", expectedRuleId: "process-killall" },
	// `process-killall` keeps a plain `\b` on purpose: this really does tear down every workload.
	{ command: "/usr/local/bin/k3s-killall.sh", expectedRuleId: "process-killall" },
	{ command: "pkill -f webpack", expectedRuleId: "process-pkill" },
	// `-KILL` used to make this match `process-kill` first. Still gated, now attributed to the
	// command actually being run — which also moves its approval key, deliberately.
	{ command: "pkill -KILL webpack", expectedRuleId: "process-pkill" },
	{ command: "npm uninstall lodash", expectedRuleId: "package-npm-remove" },
	{ command: "yarn remove lodash", expectedRuleId: "package-yarn-remove" },
	{ command: "pip uninstall requests", expectedRuleId: "package-pip-uninstall" },
	{ command: "pip3 uninstall requests", expectedRuleId: "package-pip3-uninstall" },
	{ command: "pnpm remove lodash", expectedRuleId: "package-pnpm-remove" },
	{ command: "poetry remove requests", expectedRuleId: "package-poetry-remove" },
	{ command: "mvn -Prelease deploy", expectedRuleId: "package-maven-release" },
	{ command: "brew uninstall node", expectedRuleId: "package-brew-remove" },
	{ command: "apt-get purge nginx", expectedRuleId: "package-apt-remove" },
	{ command: "docker rm container-1", expectedRuleId: "container-docker-destructive" },
	{ command: "docker compose down --volumes", expectedRuleId: "container-docker-compose-down-volumes" },
	{ command: "docker-compose down --volumes", expectedRuleId: "container-docker-compose-down-volumes" },
	{ command: "docker image prune -a", expectedRuleId: "container-docker-image-prune" },
	{ command: "docker builder prune -f", expectedRuleId: "container-docker-builder-prune" },
	{ command: 'psql -c "DELETE FROM users"', expectedRuleId: "database-delete" },
	{ command: 'mysql -e "DROP TABLE accounts"', expectedRuleId: "database-drop" },
	{ command: 'sqlite3 db.sqlite "TRUNCATE TABLE sessions"', expectedRuleId: "database-truncate" },
	{ command: 'echo "DELETE FROM users"', expectedRuleId: null },
	{ command: "git push --force-with-lease", expectedRuleId: "git-force-push" },
	{ command: "git reset --hard HEAD~1", expectedRuleId: "git-reset-hard" },
	{ command: "git clean -fdx", expectedRuleId: "git-clean-force" },
	{ command: "git clean -xdf", expectedRuleId: "git-clean-force" },
	{ command: "git clean -n", expectedRuleId: null },
	{ command: "sudo rm -r dist", expectedRuleId: "filesystem-rm-recursive" },
	// `privilege-sudo` keeps a plain `\b` on purpose, and until now had no positive case at all.
	{ command: "ansible-playbook --sudo site.yml", expectedRuleId: "privilege-sudo" },
	{ command: "su", expectedRuleId: "privilege-su" },
	{ command: "su root", expectedRuleId: "privilege-su" },
	// Ansible's other become-method spellings. Same escalation as `--sudo`, so same gate.
	{ command: "ansible-playbook --su -i hosts site.yml", expectedRuleId: "privilege-su" },
	{ command: "ansible-playbook --su-user root site.yml", expectedRuleId: "privilege-su" },
	{ command: "du -su /tmp", expectedRuleId: null, nearMissFor: "privilege-su" },
	{ command: "sort -su names.txt", expectedRuleId: null },
	{ command: "shutdown -h now", expectedRuleId: "system-shutdown" },
	// A hyphenated command *name*, which the flag-position exclusion alone cannot tell from a flag.
	{ command: "openrc-shutdown -r now", expectedRuleId: "system-shutdown" },
	{ command: "latex --halt-on-error paper.tex", expectedRuleId: null, nearMissFor: "system-shutdown" },
	{ command: "chmod 777 shared", expectedRuleId: "system-chmod-777" },
	{ command: "chmod 1777 shared", expectedRuleId: null },
	{ command: "kubectl delete pod web-123", expectedRuleId: "infra-kubectl-delete" },
	{ command: "terraform destroy -auto-approve", expectedRuleId: "infra-terraform-destroy" },
	{ command: "helm uninstall release-name", expectedRuleId: "infra-helm-uninstall" },
];

test("matches every command case to the expected rule, including the negatives", () => {
	// Guards against a case silently disappearing from the table during a refactor.
	assert.equal(CASES.length, 64);

	for (const { command, expectedRuleId } of CASES) {
		const actualRuleId = evaluateDangerousCommand(command).matchedRule?.id ?? null;
		assert.equal(actualRuleId, expectedRuleId, `command: ${JSON.stringify(command)}`);
	}
});

test("every expected rule id exists in the catalogue", () => {
	const known = new Set(PERMISSION_GATE_RULES.map((rule) => rule.id));

	for (const { expectedRuleId } of CASES) {
		if (expectedRuleId === null) continue;
		assert.ok(known.has(expectedRuleId), `unknown rule id in the case table: ${expectedRuleId}`);
	}
});

// The reverse direction of the test above, and the one that matters (T8). Checking only that every
// id *in the table* exists in the catalogue let `privilege-sudo` sit in the catalogue with no
// positive case at all — a rule nothing asserts drifts, and a disarming edit to one would have
// passed every check here. This is also what makes the flag-position narrowing above trustworthy:
// a prefix that accidentally excluded a whole command word now fails a test instead of going quiet.
test("every rule in the catalogue has at least one positive case", () => {
	const covered = new Set(CASES.map(({ expectedRuleId }) => expectedRuleId).filter((id) => id !== null));

	for (const { id } of PERMISSION_GATE_RULES) {
		assert.ok(covered.has(id), `no positive case in the table for rule: ${id}`);
	}
});

test("every flag-position-narrowed rule keeps a tagged near-miss negative", () => {
	const nearMissed = new Set(
		CASES.filter(({ expectedRuleId, nearMissFor }) => expectedRuleId === null && nearMissFor).map(
			({ nearMissFor }) => nearMissFor,
		),
	);

	for (const id of FLAG_POSITION_NARROWED_RULES) {
		assert.ok(nearMissed.has(id), `no near-miss negative in the table for narrowed rule: ${id}`);
	}
});

// The two deliberate exclusions are asserted rather than only commented, because a later pass that
// "makes the catalogue consistent" would silently disarm `ansible-playbook --sudo` and
// `k3s-killall.sh` while every other test above stayed green (P3, P4).
test("keeps the flag-position exclusion off the rules that must not have it", () => {
	const FLAG_POSITION_EXCLUSION = String.raw`(?<![-\w])`;
	const byId = new Map(PERMISSION_GATE_RULES.map((rule) => [rule.id, rule]));

	for (const id of FLAG_POSITION_NARROWED_RULES) {
		assert.ok(byId.get(id)?.pattern.source.includes(FLAG_POSITION_EXCLUSION), `rule lost the exclusion: ${id}`);
	}

	for (const id of ["privilege-sudo", "process-killall"]) {
		assert.ok(
			!byId.get(id)?.pattern.source.includes(FLAG_POSITION_EXCLUSION),
			`rule must keep a plain \\b — a -prefixed occurrence is a true positive: ${id}`,
		);
	}
});

test("collapses whitespace before matching", () => {
	assert.equal(normalizeCommand("  rm   -r    dist  "), "rm -r dist");
});

test("binds the approval key to both the matched rule and the normalized command", () => {
	const evaluation = evaluateDangerousCommand("  rm   -r    dist  ");

	assert.ok(evaluation.matchedRule);
	assert.equal(
		createSessionApprovalKey(evaluation.matchedRule, evaluation.normalizedCommand),
		"filesystem-rm-recursive::rm -r dist",
	);
	assert.equal(evaluation.sessionApprovalKey, "filesystem-rm-recursive::rm -r dist");
});
