import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sha = "a".repeat(40);
const checksum = createHash("sha256").update("artifact").digest("hex");
const git = `#!/usr/bin/env bash
case "$1" in
  tag)
    case " $* " in
      *" --points-at "*) printf '%s\\n' "$AT_TAG" ;;
      *" --merged "*) printf '%s\\n' "$MERGED_TAGS" ;;
      *) printf '%s\\n' "$ALL_TAGS" ;;
    esac ;;
  merge-base) exit "\${ANCESTOR:-0}" ;;
  rev-parse) printf '%s\\n' "$GITHUB_SHA" ;;
  diff) if [[ " $* " != *" --diff-filter=M "* ]]; then printf '%s\\0' "\${CHANGED_PATH:-src/index.ts}"; fi ;;
  log) printf '%s\\n' "fix: test release" ;;
  rev-list)
    if [[ "$2" == v1.0.0..HEAD ]]; then echo unsafe-change; else echo safe-change; fi ;;
  *) exit 99 ;;
esac
`;
const gh = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const env = process.env;
const [verb, action, ...args] = process.argv.slice(2);
const command = [action, ...args].join(" ");
if (verb === "release" && action === "create") {
  appendFileSync(join(env.RUNNER_TEMP, "published"), args.join(" ") + "\\n");
} else if (verb === "release" && action === "download") {
  const name = args[args.indexOf("--pattern") + 1];
  const digest = env.BAD_CHECKSUM === "yes" ? "b".repeat(64) : env.EXPECTED_CHECKSUM;
  writeFileSync(join(env.RUNNER_TEMP, name), digest + "  " + name.slice(0, -7) + "\\n");
} else if (command.includes("/releases/tags/")) {
  process.stdout.write(env.RELEASE);
} else if (command.includes("/releases?")) {
  console.log(env.STABLE_TAGS);
} else if (command.includes("/actions/workflows/")) {
  console.log("100");
} else if (command.includes("/actions/runs/")) {
  if (env.GREEN === "yes") console.log("200");
} else if (command.includes("/commits/unsafe-change/pulls")) {
  console.log("rollback-unsafe");
} else if (!command.includes("/commits/safe-change/pulls")) {
  process.exitCode = 99;
}
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hub-release-flow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "git"), git, { mode: 0o700 });
  writeFileSync(join(dir, "gh"), gh, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: join(dir, "outputs"),
    GITHUB_SHA: sha,
    DEPLOY_SHA: sha,
    GITHUB_REPOSITORY: "skevetter/hub",
    GITHUB_REF: "refs/heads/main",
    EXPECTED_CHECKSUM: checksum,
    MERGED_TAGS: "v1.0.0",
    ALL_TAGS: "v1.0.0",
    STABLE_TAGS: "v1.0.0",
    AT_TAG: "v1.0.1",
    GREEN: "yes",
  };
  return {
    dir,
    run(script, args, overrides = {}) {
      writeFileSync(env.GITHUB_OUTPUT, "");
      const result = spawnSync("bash", [`scripts/cd/${script}.sh`, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...overrides },
      });
      const output = readFileSync(env.GITHUB_OUTPUT, "utf8");
      return { ...result, output };
    },
  };
}

test("holds v1.0.1 and v1.0.2 until promotion, then clears v1.0.3", (t) => {
  const { run } = fixture(t);
  const plan = (overrides) => {
    const result = run("package", ["plan"], overrides);
    assert.equal(result.status, 0, result.stderr);
    return result.output;
  };
  assert.match(plan({ MERGED_TAGS: "v9.0.0-rc.1\nv1.0.0" }), /version=1.0.1\nheld=true/u);
  assert.match(plan({ MERGED_TAGS: "v1.0.1\nv1.0.0" }), /version=1.0.2\nheld=true/u);
  assert.match(
    plan({ MERGED_TAGS: "v1.0.2\nv1.0.1\nv1.0.0", STABLE_TAGS: "v1.0.2\nv1.0.0" }),
    /version=1.0.3\nheld=false/u,
  );
});

test("holds risky migration SQL without a pull request label", (t) => {
  const { run } = fixture(t);
  const result = run("package", ["plan"], {
    MERGED_TAGS: "v1.0.2",
    STABLE_TAGS: "v1.0.2",
    CHANGED_PATH: "drizzle/0000_phase_0_spine.sql",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /version=1.0.3\nheld=true/u);
});

test("publishes only the current release plan and the checked artifact", (t) => {
  const { dir, run } = fixture(t);
  const file = "getpaseo-hub-1.0.1.tgz";
  writeFileSync(join(dir, file), "artifact");
  writeFileSync(join(dir, `${file}.sha256`), `${checksum}  ${file}\n`);
  const publish = (overrides) =>
    run("package", ["publish", "1.0.1", dir], {
      BASE_TAG: "v1.0.0",
      HELD: "true",
      ...overrides,
    });
  assert.equal(publish({ ALL_TAGS: "v1.0.2\nv1.0.0" }).status, 1);
  assert.equal(publish({ ANCESTOR: "1" }).status, 1);
  assert.equal(publish({ EXPECTED_CHECKSUM: "b".repeat(64) }).status, 1);
  const result = publish({});
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(dir, "published"), "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /--prerelease/u);
});

function release() {
  const login = "github-actions[bot]";
  const asset = { state: "uploaded", uploader: { login } };
  const name = "getpaseo-hub-1.0.1.tgz";
  return {
    draft: false,
    tag_name: "v1.0.1",
    prerelease: true,
    author: { login },
    assets: [
      { ...asset, name, digest: `sha256:${checksum}` },
      { ...asset, name: `${name}.sha256` },
    ],
  };
}

test("dispatch requires a main ancestor, one tag, green CI, and a matching bot release", (t) => {
  const { run } = fixture(t);
  const guard = (overrides, listing = release()) =>
    run("dispatch", [], { RELEASE: JSON.stringify(listing), ...overrides });
  const good = guard({});
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.output, `version=1.0.1\nchecksum=${checksum}\nprerelease=true\n`);
  for (const item of [
    { AT_TAG: "" },
    { AT_TAG: "v1.0.1\nv1.0.2" },
    { AT_TAG: "v01.0.1" },
    { ANCESTOR: "1" },
    { GREEN: "no" },
    { BAD_CHECKSUM: "yes" },
  ]) {
    assert.notEqual(guard(item).status, 0, JSON.stringify(item));
  }
  const wrongDigest = release();
  wrongDigest.assets[0].digest = "sha256:broken";
  const wrongUploader = release();
  wrongUploader.assets[0].uploader = { login: "other" };
  const wrongChecksumUploader = release();
  wrongChecksumUploader.assets[1].uploader = { login: "other" };
  for (const listing of [
    { ...release(), author: { login: "other" } },
    wrongDigest,
    wrongUploader,
    wrongChecksumUploader,
    { ...release(), draft: true },
    { ...release(), tag_name: "v1.0.2" },
  ]) {
    assert.notEqual(guard({}, listing).status, 0, JSON.stringify(listing));
  }
});
