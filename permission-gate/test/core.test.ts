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
}

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
	{ command: "rm src/*", expectedRuleId: "filesystem-rm-wildcard" },
	{ command: "rmdir old-dir", expectedRuleId: "filesystem-rmdir" },
	{ command: "shred secrets.txt", expectedRuleId: "filesystem-shred" },
	{ command: "echo nope > /etc/hosts", expectedRuleId: "filesystem-sensitive-redirect" },
	{ command: "echo ok > /tmp/out.txt", expectedRuleId: null },
	{ command: "echo ok >> /var/tmp/out.txt", expectedRuleId: null },
	{ command: "echo hi > /dev/null", expectedRuleId: null },
	{ command: "truncate -s 0 /tmp/file", expectedRuleId: "filesystem-truncate" },
	{ command: "kill 1234", expectedRuleId: "process-kill" },
	{ command: "killall node", expectedRuleId: "process-killall" },
	{ command: "pkill -f webpack", expectedRuleId: "process-pkill" },
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
	{ command: "su", expectedRuleId: "privilege-su" },
	{ command: "su root", expectedRuleId: "privilege-su" },
	{ command: "shutdown -h now", expectedRuleId: "system-shutdown" },
	{ command: "chmod 777 shared", expectedRuleId: "system-chmod-777" },
	{ command: "chmod 1777 shared", expectedRuleId: null },
	{ command: "kubectl delete pod web-123", expectedRuleId: "infra-kubectl-delete" },
	{ command: "terraform destroy -auto-approve", expectedRuleId: "infra-terraform-destroy" },
	{ command: "helm uninstall release-name", expectedRuleId: "infra-helm-uninstall" },
];

test("matches every command case to the expected rule, including the negatives", () => {
	// Guards against a case silently disappearing from the table during a refactor.
	assert.equal(CASES.length, 48);

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
