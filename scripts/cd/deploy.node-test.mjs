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
  wait\\ 60)
    if [[ -n "$INTERRUPT" ]]; then kill -s "$INTERRUPT" "$DEPLOY_PID"; fi
    if ! grep -qx rollback "$RUNNER_TEMP/calls"; then
      case "$WAIT" in
        running) echo '{"ok":false,"state":"running"}'; exit 5 ;;
        failed) echo '{"ok":false,"state":"failed","code":"interrupted"}'; exit 3 ;;
        invalid) echo '{"ok":false,"state":"failed","code":"ok"}'; exit 3 ;;
      esac
    fi
    echo '{"ok":true,"state":"done"}' ;;
  wait*) echo '{"ok":true,"state":"done"}' ;;
  record*) if [[ "$RECORD_FAIL" == yes ]]; then echo '{"ok":false}'; exit 4; fi
    echo '{"ok":true}' ;;
  smoke\\ 1.1.0)
    if [[ "$SMOKE_FAIL" == yes ]]; then echo '{"ok":false,"checks":{"local_health":false}}'; exit 3; fi
    echo '{"ok":true,"checks":{"local_health":true}}' ;;
  rollback) echo '{"ok":true,"to":"1.0.0"}' ;;
  unknown|precheck\\ 0.0.1*|000*)
    if [[ "$ACCEPT" != yes ]]; then
      printf '{"ok":false,"reason":"%s"}\\n' "\${REFUSAL:-refused}"
      exit 2
    fi
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
    writeFileSync(join(temp, "calls"), "");
    const args =
      typeof action === "string"
        ? ["-c", 'export DEPLOY_PID=$$; exec bash "$@"', "test", source, action]
        : action;
    const outputPath = join(temp, "output");
    writeFileSync(outputPath, "");
    const result = spawnSync("bash", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: outputPath,
        RUNNING: "null",
        CD_DIR: fileURLToPath(new URL(".", import.meta.url)),
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
    const calls = readFileSync(join(temp, "calls"), "utf8").trim().split("\n").filter(Boolean);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /sensitive\.example|hub-deploy-key|database\.dump|15123/u,
    );
    return { ...result, calls, output: readFileSync(outputPath, "utf8") };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const deployCalls = ["status", "precheck", "quiet", "backup", "install", "wait", "smoke"];

test("deploys from a null running commit and records only after smoke", () => {
  const result = execute("deploy");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [...deployCalls, "record"]);
  assert.equal(result.output, "install_accepted=true\ndeployed=true\n");
});

test("skips a superseded commit before precheck", () => {
  const result = execute("deploy", { RUNNING: JSON.stringify("c".repeat(40)), ANCESTRY: "1" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Skipping superseded/u);
  assert.deepEqual(result.calls, ["status"]);
  assert.equal(result.output, "");
  const manual = execute("deploy", {
    RUNNING: JSON.stringify("c".repeat(40)),
    ANCESTRY: "1",
    MANUAL_DEPLOY: "true",
  });
  assert.equal(manual.status, 1);
  assert.equal(manual.output, "");
  assert.deepEqual(manual.calls, ["status"]);
});

test("pauses on INT or TERM after the install is accepted", () => {
  for (const [INTERRUPT, code] of [
    ["INT", 130],
    ["TERM", 143],
  ]) {
    const result = execute("deploy", { INTERRUPT });
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.output, "install_accepted=true\n");
    assert.deepEqual(result.calls, [...deployCalls.slice(0, 6), "pause"]);
  }
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

test("polls exit 5 exactly 15 times, then pauses without rollback", () => {
  const result = execute("deploy", { WAIT: "running" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [...deployCalls.slice(0, 5), ...Array(15).fill("wait"), "pause"]);
});

test("recovers from a terminal install failure and pauses on ambiguous failures", () => {
  const failed = execute("deploy", { WAIT: "failed" });
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.calls, [
    ...deployCalls.slice(0, 6),
    "rollback",
    "wait",
    "smoke",
    "pause",
  ]);
  const invalid = execute("deploy", { WAIT: "invalid" });
  assert.equal(invalid.status, 1);
  assert.deepEqual(invalid.calls, [...deployCalls.slice(0, 6), "pause"]);
  const record = execute("deploy", { RECORD_FAIL: "yes" });
  assert.equal(record.status, 1);
  assert.deepEqual(record.calls, [...deployCalls, "record", "pause"]);
});

function call(...args) {
  return execute(["-c", 'source "$CD_DIR/ssh.sh"; cd_call "$@"', "test", ...args]);
}

test("validates wait bounds and rejects malformed arguments locally", () => {
  for (const value of ["0", "121", "060", "900", "60 60"]) {
    const result = call("wait", value);
    assert.equal(result.status, 2, value);
    assert.deepEqual(result.calls, []);
  }
  for (const value of ["1", "120"]) assert.equal(call("wait", value).status, 0);
  assert.deepEqual(call("install", "01.0.0", "a".repeat(64)).calls, []);
  assert.deepEqual(call("quiet", "601").calls, []);
  assert.deepEqual(call("pause", "A").calls, []);
});

test("rejects malformed refusal replies and accepts the protocol reasons", () => {
  for (const REFUSAL of [
    "refused",
    "paused",
    "not-newer",
    "no-space",
    "install-running",
    "no-previous",
    "no-tarball",
  ]) {
    assert.equal(execute("selftest", { REFUSAL }).status, 0);
  }
  assert.equal(execute("selftest", { REFUSAL: "unknown-reason" }).status, 1);
});
