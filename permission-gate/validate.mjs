/**
 * Permission gate validation helper.
 *
 * Purpose:
 * - smoke-test the global permission-gate policy outside the repository
 * - keep regression coverage next to the global extension it validates
 * - ensure rule changes and ordering changes are verified with concrete examples
 *
 * This file is intentionally not an extension entrypoint. Pi auto-discovers `.ts`
 * extension files, not this `.mjs` helper.
 *
 * Run manually:
 *   node ~/.pi/agent/extensions/permission-gate/validate.mjs
 */

import {
  createSessionApprovalKey,
  evaluateDangerousCommand,
  normalizeCommand,
} from "./core.mjs";

// Keep cases ordered roughly by rule groups so future diffs stay readable.
// When adding or reordering rules in core.mjs, update this file in the same pass.
const cases = [
  { command: "rm -rf dist", expectedRuleId: "filesystem-rm-recursive" },
  { command: "rm -r dist", expectedRuleId: "filesystem-rm-recursive" },
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

let failures = 0;

for (const testCase of cases) {
  const actualRuleId = evaluateDangerousCommand(testCase.command).matchedRule?.id ?? null;
  if (actualRuleId !== testCase.expectedRuleId) {
    failures += 1;
    console.error(`FAIL match: ${JSON.stringify(testCase.command)} expected=${testCase.expectedRuleId} actual=${actualRuleId}`);
  }
}

const normalizedCommand = normalizeCommand("  rm   -r    dist  ");
const evaluation = evaluateDangerousCommand("  rm   -r    dist  ");
const expectedApprovalKey = "filesystem-rm-recursive::rm -r dist";
const actualApprovalKey = evaluation.matchedRule
  ? createSessionApprovalKey(evaluation.matchedRule, normalizedCommand)
  : null;

if (normalizedCommand !== "rm -r dist") {
  failures += 1;
  console.error(`FAIL normalize: expected=\"rm -r dist\" actual=${JSON.stringify(normalizedCommand)}`);
}

if (actualApprovalKey !== expectedApprovalKey) {
  failures += 1;
  console.error(`FAIL approval key: expected=${expectedApprovalKey} actual=${actualApprovalKey}`);
}

if (failures > 0) {
  console.error(`\npermission-gate validation failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log(`permission-gate validation passed (${cases.length} command cases + 2 normalization/key checks).`);
