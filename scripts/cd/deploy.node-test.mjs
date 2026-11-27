import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./deploy.sh", import.meta.url));
const ssh = `#!/usr/bin/env bash
command=\${@: -1}
printf '%s\\n' "\${command%% *}" >> "$RUNNER_TEMP/calls"
echo "$VPS2_SSH_HOST $RUNNER_TEMP/hub-deploy-key" >&2
if [[ "$command" == "$SLOW_CALL" ]]; then
  node -p 'Date.now()' > "$RUNNER_TEMP/signal-time"
  kill -s "$SLOW_SIGNAL" "$DEPLOY_PID"
  sleep 4
  printf '%s\\n' slow-reply >> "$RUNNER_TEMP/calls"
fi
case "$command" in
  status)
    if grep -qx rollback "$RUNNER_TEMP/calls"; then
      jq -cn --arg version "\${STATUS_VERSION:-\${ROLLBACK_TO:-1.0.0}}" \\
        --argjson paused "$(test -f "$RUNNER_TEMP/paused" && echo true || echo false)" \\
        '{ok:true, commit:null, version:$version, previous_version:null, paused:$paused}'
    else
      echo "{\\"ok\\":true,\\"commit\\":$RUNNING,\\"private\\":\\"$VPS2_SSH_HOST\\",\\"version\\":\\"1.0.0\\\\n$VPS2_SSH_HOST\\"}"
    fi ;;
  backup*) echo '{"ok":true,"entries":5,"bytes":99,"file":"/private/database.dump"}' ;;
  install*)
    if [[ "$REFUSE_INSTALL" == yes ]]; then echo '{"ok":false,"reason":"refused"}'; exit 2; fi
    if [[ -n "$INTERRUPT_INSTALL" ]]; then
      kill -s "$INTERRUPT_INSTALL" "$DEPLOY_PID"
      for ((i=0; i<100; i++)); do
        if grep -qx pause "$RUNNER_TEMP/calls"; then break; fi
        sleep 0.02
      done
      printf '%s\\n' install-reply >> "$RUNNER_TEMP/calls"
    fi
    echo '{"ok":true}' ;;
  wait\\ 60)
    if [[ -n "$INTERRUPT" ]]; then kill -s "$INTERRUPT" "$DEPLOY_PID"; fi
    if ! grep -qx rollback "$RUNNER_TEMP/calls"; then
      case "$WAIT" in
        running) echo '{"ok":false,"state":"running"}'; exit 5 ;;
        failed) echo cd-failed > "$RUNNER_TEMP/paused"
          echo '{"ok":false,"state":"failed","code":"interrupted"}'; exit 3 ;;
        pre-swap) echo '{"ok":false,"state":"failed","code":"download"}'; exit 3 ;;
        invalid) echo '{"ok":false,"state":"failed","code":"ok"}'; exit 3 ;;
      esac
    fi
    if grep -qx rollback "$RUNNER_TEMP/calls"; then echo cd-failed > "$RUNNER_TEMP/paused"; fi
    echo '{"ok":true,"state":"done","operation":"rollback"}' ;;
  wait*) echo '{"ok":true,"state":"done"}' ;;
  record*) if [[ "$RECORD_FAIL" == yes ]]; then echo '{"ok":false}'; exit 4; fi
    echo '{"ok":true}' ;;
  pause*)
    [[ " $* " == *" ConnectTimeout=5 "* ]] || exit 4
    node -p 'Date.now()' > "$RUNNER_TEMP/pause-time"
    printf '%s\\n' "\${command#pause }" > "$RUNNER_TEMP/paused"
    echo '{"ok":true}' ;;
  smoke\\ 1.1.0)
    if [[ "$SMOKE_FAIL" == yes ]]; then echo '{"ok":false,"checks":{"local_health":false}}'; exit 3; fi
    echo '{"ok":true,"checks":{"local_health":true}}' ;;
  rollback)
    if [[ "$REFUSE_ROLLBACK" == yes ]]; then echo '{"ok":false,"reason":"no-previous"}'; exit 2; fi
    jq -cn --arg to "\${ROLLBACK_TO:-1.0.0}" --argjson started "\${ROLLBACK_STARTED:-true}" \\
      '{ok:true, started:$started, to:$to}' ;;
  "smoke \${ROLLBACK_TO:-1.0.0}")
    if [[ "$ROLLBACK_SMOKE_FAIL" == yes ]]; then echo '{"ok":false}'; exit 3; fi
    echo '{"ok":true}' ;;
  smoke*) echo '{"ok":false,"reason":"refused"}'; exit 2 ;;
  unknown|precheck\\ 0.0.1*|000*)
    if [[ "$ACCEPT" != yes ]]; then
      printf '{"ok":false,"reason":"%s"}\\n' "\${REFUSAL:-refused}"
      exit 2
    fi
    echo '{"ok":true}' ;;
  precheck*)
    if [[ "$PAUSED_PRECHECK" == yes ]]; then echo '{"ok":false,"reason":"paused"}'; exit 2; fi
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
    const summaryPath = join(temp, "summary");
    const pausePath = join(temp, "paused");
    writeFileSync(outputPath, "");
    writeFileSync(summaryPath, "");
    const result = spawnSync("bash", args, {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
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
    const pauseDelay =
      options.SLOW_CALL && calls.includes("pause")
        ? Number(readFileSync(join(temp, "pause-time"), "utf8")) -
          Number(readFileSync(join(temp, "signal-time"), "utf8"))
        : undefined;
    return {
      ...result,
      calls,
      pauseDelay,
      output: readFileSync(outputPath, "utf8"),
      summary: readFileSync(summaryPath, "utf8"),
      pauseReason: existsSync(pausePath) ? readFileSync(pausePath, "utf8").trim() : null,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const deployCalls = ["status", "precheck", "quiet", "backup", "install", "wait", "smoke"];

test("deploys from a null running commit and records only after smoke", () => {
  const result = execute("deploy");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [...deployCalls, "record"]);
  assert.equal(result.output, "install_attempted=true\ndeployed=true\n");
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
    assert.equal(result.output, "install_attempted=true\noutcome=interrupted\n");
    assert.deepEqual(result.calls, [...deployCalls.slice(0, 6), "pause"]);
  }
});

test("pauses on INT or TERM before the remote install replies", () => {
  for (const [INTERRUPT_INSTALL, code] of [
    ["INT", 130],
    ["TERM", 143],
  ]) {
    const result = execute("deploy", { INTERRUPT_INSTALL });
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.output, "install_attempted=true\noutcome=interrupted\n");
    assert.deepEqual(result.calls, [...deployCalls.slice(0, 5), "pause", "install-reply"]);
  }
});

test("clears the attempted flag without pausing when install is refused", () => {
  const result = execute("deploy", { REFUSE_INSTALL: "yes" });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.output, "install_attempted=true\ninstall_attempted=false\n");
  assert.deepEqual(result.calls, deployCalls.slice(0, 5));
});

for (const [SLOW_CALL, SLOW_SIGNAL, code] of [
  ["wait 60", "INT", 130],
  ["smoke 1.1.0", "TERM", 143],
  [`record 1.1.0 ${"a".repeat(40)}`, "TERM", 143],
]) {
  const verb = SLOW_CALL.split(" ")[0];
  test(`pauses within 3 seconds while ${verb} is in flight`, () => {
    const result = execute("deploy", { SLOW_CALL, SLOW_SIGNAL });
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.output, "install_attempted=true\noutcome=interrupted\n");
    assert.ok(
      result.pauseDelay >= 0 && result.pauseDelay < 3000,
      `pause took ${result.pauseDelay}ms`,
    );
    assert.deepEqual(result.calls.slice(-3), [verb, "pause", "slow-reply"]);
  });
}

test("fails closed when git cannot establish ancestry", () => {
  const result = execute("deploy", { RUNNING: JSON.stringify("c".repeat(40)), ANCESTRY: "128" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ["status"]);
});

test("rolls back, waits, smokes and pauses after a failed smoke", () => {
  const result = execute("deploy", { SMOKE_FAIL: "yes" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, [...deployCalls, "rollback", "wait", "smoke", "pause"]);
  assert.match(result.output, /outcome=rolled-back\n/u);
  const failed = execute("deploy", { SMOKE_FAIL: "yes", ROLLBACK_SMOKE_FAIL: "yes" });
  assert.equal(failed.status, 1);
  assert.match(failed.output, /outcome=rollback-failed\n/u);
});

const bootstrap = "0.11.0-notifications.38";

test("smokes the bootstrap after a rollback and repeats the host pause safely", () => {
  const result = execute("deploy", { WAIT: "failed", ROLLBACK_TO: bootstrap });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls.slice(-4), ["rollback", "wait", "smoke", "pause"]);
  assert.match(result.output, /outcome=rolled-back\n/u);
  assert.equal(result.pauseReason, "cd-failed");
});

test("waits and smokes even when the host reports a no-op rollback", () => {
  const result = execute("deploy", {
    WAIT: "pre-swap",
    ROLLBACK_TO: bootstrap,
    ROLLBACK_STARTED: "false",
  });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls.slice(-4), ["rollback", "wait", "smoke", "pause"]);
  assert.match(result.summary, /"started":false/u);
  assert.match(result.output, /outcome=rolled-back\n/u);
  assert.equal(result.pauseReason, "cd-failed");
});

for (const [label, options, expectedCalls] of [
  ["success", {}, ["pause", "rollback", "wait", "status", "smoke"]],
  [
    "smoke failure",
    { ROLLBACK_SMOKE_FAIL: "yes" },
    ["pause", "rollback", "wait", "status", "smoke"],
  ],
  ["refusal", { REFUSE_ROLLBACK: "yes" }, ["pause", "rollback"]],
  ["wrong running version", { STATUS_VERSION: "1.1.0" }, ["pause", "rollback", "wait", "status"]],
]) {
  test(`manual rollback leaves deploys paused on ${label}`, () => {
    const result = execute("rollback", { ROLLBACK_TO: bootstrap, ...options });
    const success = label === "success";
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    assert.deepEqual(result.calls, expectedCalls);
    assert.equal(result.pauseReason, "cd-failed");
    assert.ok(result.summary.includes(success ? "Rollback completed." : "Rollback failed."));
    if (label === "refusal") assert.match(result.summary, /"reason":"no-previous"/u);
  });
}

test("rolls back a dispatched stable release but never a held prerelease", () => {
  for (const PRERELEASE of ["false", "true"]) {
    const result = execute("deploy", { SMOKE_FAIL: "yes", MANUAL_DEPLOY: "true", PRERELEASE });
    assert.equal(result.status, 1);
    const rollback = PRERELEASE === "true" ? [] : ["rollback", "wait", "smoke"];
    assert.deepEqual(result.calls, [...deployCalls, ...rollback, "pause"]);
  }
});

test("reports a paused precheck without attempting install", () => {
  const result = execute("deploy", { PAUSED_PRECHECK: "yes" });
  assert.equal(result.status, 2);
  assert.equal(result.output, "outcome=paused-precheck\n");
  assert.deepEqual(result.calls, ["status", "precheck"]);
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
  assert.match(result.output, /outcome=install-timeout\n/u);
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
  assert.match(record.output, /outcome=record-failed\n/u);
});

function call(...args) {
  return execute(["-c", 'source "$CD_DIR/ssh.sh"; cd_call "$@"', "test", ...args]);
}

test("accepts bootstrap versions only for smoke, not release-changing requests", () => {
  for (const args of [
    ["install", bootstrap, "a".repeat(64)],
    ["backup", bootstrap],
    ["precheck", bootstrap, "a".repeat(40)],
    ["record", bootstrap, "a".repeat(40)],
  ]) {
    const result = call(...args);
    assert.equal(result.status, 2);
    assert.deepEqual(result.calls, []);
  }
});

test("rejects malformed installed versions in smoke arguments and rollback replies", () => {
  for (const version of [
    "0.11.0-notifications.038",
    "0.11.0-notifications.",
    "0.11.0-notifications.38-extra",
    `${bootstrap}\n`,
    "1.0.0-notifications.38",
  ]) {
    const result = call("smoke", version);
    assert.equal(result.status, 2, JSON.stringify(version));
    assert.deepEqual(result.calls, []);
    const rollback = execute("rollback", { ROLLBACK_TO: version });
    assert.equal(rollback.status, 1);
    assert.deepEqual(rollback.calls, ["pause", "rollback", "wait"]);
    assert.match(rollback.summary, /"to":null/u);
  }
});

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
