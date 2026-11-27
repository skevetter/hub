import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./deploy.sh", import.meta.url));
const ssh = `#!/usr/bin/env bash
command=\${@: -1}
printf '%s\\n' "\${command%% *}" >> "$RUNNER_TEMP/calls"
echo "$VPS2_SSH_HOST $RUNNER_TEMP/hub-deploy-key" >&2
case "$command" in
  status) echo "{\\"ok\\":true,\\"commit\\":$RUNNING,\\"private\\":\\"$VPS2_SSH_HOST\\",\\"version\\":\\"1.0.0\\\\n$VPS2_SSH_HOST\\"}" ;;
  backup*) echo '{"ok":true,"entries":5,"bytes":99,"file":"/private/database.dump"}' ;;
  wait*) echo '{"ok":true,"state":"done"}' ;;
  smoke\\ 1.1.0)
    if [[ "$SMOKE_FAIL" == yes ]]; then echo '{"ok":false,"checks":{"local_health":false}}'; exit 3; fi
    echo '{"ok":true,"checks":{"local_health":true}}' ;;
  rollback) echo '{"ok":true,"to":"1.0.0"}' ;;
  unknown|precheck\\ 0.0.1*|000*)
    if [[ "$ACCEPT" != yes ]]; then echo '{"ok":false,"reason":"refused"}'; exit 2; fi
    echo '{"ok":true}' ;;
  *) echo '{"ok":true}' ;;
esac
`;
const curl = `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then
    printf '{"ok":true}\\n' > "$2"
    shift
  fi
  shift
done
printf 200
`;

function execute(action, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), "hub-fake-ssh-"));
  try {
    writeFileSync(join(temp, "ssh"), ssh, { mode: 0o700 });
    writeFileSync(join(temp, "curl"), curl, { mode: 0o700 });
    writeFileSync(join(temp, "git"), '#!/usr/bin/env bash\nexit "$ANCESTRY"\n', { mode: 0o700 });
    const result = spawnSync("bash", [source, action], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        RUNNING: "null",
        ANCESTRY: "0",
        VPS2_SSH_HOST: "sensitive.example.test",
        VPS2_SSH_PORT: "15123",
        DEPLOY_SHA: "a".repeat(40),
        DEPLOY_VERSION: "1.1.0",
        DEPLOY_CHECKSUM: "b".repeat(64),
        HUB_PUBLIC_URL: "https://public.example.test",
        MANUAL_DEPLOY: "false",
        ...options,
      },
    });
    const calls = readFileSync(join(temp, "calls"), "utf8").trim().split("\n");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /sensitive\.example|hub-deploy-key|database\.dump|15123/u,
    );
    return { ...result, calls };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const deployCalls = ["status", "precheck", "quiet", "backup", "install", "wait", "smoke"];

test("deploys from a null running commit and records only after smoke", () => {
  const result = execute("deploy");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [...deployCalls, "record"]);
});

test("skips a superseded commit before precheck", () => {
  const result = execute("deploy", { RUNNING: JSON.stringify("c".repeat(40)), ANCESTRY: "1" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Skipping superseded/u);
  assert.deepEqual(result.calls, ["status"]);
});

test("fails closed when git cannot establish ancestry", () => {
  const result = execute("deploy", { RUNNING: JSON.stringify("c".repeat(40)), ANCESTRY: "128" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ["status"]);
});

test("rolls back, waits, smokes and pauses after a failed smoke", () => {
  const result = execute("deploy", { SMOKE_FAIL: "yes" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [...deployCalls, "rollback", "wait", "smoke", "pause"]);
});

test("pauses without rollback after a manual deployment fails smoke", () => {
  const result = execute("deploy", { SMOKE_FAIL: "yes", MANUAL_DEPLOY: "true" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [...deployCalls, "pause"]);
});

test("reports each refusal and fails if any probe is accepted", () => {
  const refused = execute("selftest");
  assert.equal(refused.status, 0);
  assert.deepEqual(refused.stdout.trim().split("\n"), [
    "PASS unknown-verb",
    "PASS overlong",
    "PASS older-version",
  ]);
  const accepted = execute("selftest", { ACCEPT: "yes" });
  assert.equal(accepted.status, 1);
  assert.match(accepted.stdout, /FAIL older-version/u);
});
