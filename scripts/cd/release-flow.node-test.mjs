import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const checksum = createHash("sha256").update("artifact").digest("hex");
const gh = `#!/usr/bin/env node
const { spawnSync, execFileSync } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const env = process.env;
const [verb, action, ...args] = process.argv.slice(2);
const command = [action, ...args].join(" ");
appendFileSync(join(env.RUNNER_TEMP, "gh-calls"), verb + " " + command + "\\n");
if (verb === "issue" && action === "list") {
  console.log(JSON.stringify([{ title: "Hub CD needs attention", number: 42 }]));
  process.exit(0);
}
if (verb === "issue" && action === "comment") {
  appendFileSync(join(env.RUNNER_TEMP, "comments"), args[args.indexOf("--body") + 1] + "\\n");
  process.exit(0);
}
if (command.includes("/issues/42/comments?")) {
  console.log(JSON.stringify([{ body: "older page", user: { login: "github-actions[bot]" } }]));
  console.log(env.PREVIOUS_COMMENTS || "[]");
  process.exit(0);
}
if (verb === "release" && action === "create") {
  const [tag] = args;
  execFileSync("git", ["update-ref", "refs/tags/" + tag, args[args.indexOf("--target") + 1]]);
  appendFileSync(join(env.RUNNER_TEMP, "published"), JSON.stringify(args) + "\\n");
} else if (verb === "release" && action === "download") {
  const names = args.flatMap((arg, i) => arg === "--pattern" ? [args[i + 1]] : []);
  const file = names.find((name) => name.endsWith(".tgz"));
  const digest = env.BAD_CHECKSUM === "yes" ? "b".repeat(64) : env.EXPECTED_CHECKSUM;
  writeFileSync(file, env.BAD_ARTIFACT === "yes" ? "tampered" : "artifact");
  writeFileSync(file + ".sha256", digest + "  " + file + "\\n");
} else if (verb === "attestation" && action === "verify") {
  const expected = [
    "getpaseo-hub-1.0.1.tgz", "--repo", "skevetter/hub",
    "--signer-workflow", "skevetter/hub/.github/workflows/main.yml",
    "--source-ref", "refs/heads/main", "--source-digest", env.DEPLOY_SHA, "--deny-self-hosted-runners",
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected) || env.BAD_ATTESTATION === "yes") {
    process.exitCode = 1;
  }
} else if (command.includes("/releases/tags/")) {
  process.stdout.write(env.RELEASE);
} else if (command.includes("/actions/runs/")) {
  process.stdout.write(env.JOBS);
} else {
  let body = [];
  if (command.includes("/releases?")) body = JSON.parse(env.RELEASES);
  if (command.includes("/actions/workflows/")) {
    if (!command.includes("head_sha=" + env.DEPLOY_SHA + "&")) process.exit(99);
    body = { workflow_runs: [{ id: 100 }] };
  }
  const filter = args[args.indexOf("--jq") + 1];
  const result = spawnSync("jq", ["-r", filter], { input: JSON.stringify(body) });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hub-release-flow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "gh"), gh, { mode: 0o700 });
  cpSync(join(root, "scripts/cd"), join(dir, "scripts/cd"), { recursive: true });
  mkdirSync(join(dir, "src"));
  const save = (file, text) => writeFileSync(join(dir, file), text);
  const exec = (args, input) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", input }).trim();
  const git = (...args) => exec(args);
  git("init", "-q");
  save("src/index.ts", "initial");
  return setupFixture({ dir, save, git, exec });
}

function setupFixture({ dir, save, git, exec }) {
  const commit = (message, parent) => {
    git("add", "src", ...(message.includes("migration") ? ["drizzle"] : []));
    const headers = ["tree " + git("write-tree")];
    if (parent) headers.push("parent " + parent);
    const identity = "Fixture <fixture@example.invalid> 1700000000 +0000";
    headers.push("author " + identity, "committer " + identity);
    return exec(
      ["hash-object", "-w", "-t", "commit", "--stdin"],
      headers.join("\n") + "\n\n" + message + "\n",
    );
  };
  const base = commit("chore: base");
  git("update-ref", "HEAD", base);
  git("update-ref", "refs/tags/v1.0.0", base);
  const push = (content, message = "fix: test release") => {
    save("src/index.ts", content);
    const sha = commit(message, git("rev-parse", "HEAD"));
    git("update-ref", "HEAD", sha);
    git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: join(dir, "outputs"),
    GITHUB_REPOSITORY: "skevetter/hub",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REF: "refs/heads/main",
    EXPECTED_CHECKSUM: checksum,
    RELEASES: JSON.stringify([{ tag_name: "v1.0.0", draft: false, prerelease: false }]),
    JOBS: JSON.stringify(jobs("check / required", "success")),
  };
  const run = (script, args, overrides = {}) => {
    writeFileSync(env.GITHUB_OUTPUT, "");
    const sha = git("rev-parse", "HEAD");
    const result = spawnSync("bash", [`scripts/cd/${script}.sh`, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, GITHUB_SHA: sha, DEPLOY_SHA: sha, ...overrides },
    });
    return { ...result, output: readFileSync(env.GITHUB_OUTPUT, "utf8") };
  };
  return { dir, run, git, push, save };
}

function jobs(name, conclusion) {
  return {
    total_count: 2,
    jobs: [
      { id: 199, name: "check / static", status: "completed", conclusion: "success" },
      { id: 200, name, status: "completed", conclusion },
    ],
  };
}

function plan(run, overrides = {}) {
  const result = run("package", ["plan"], overrides);
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    result.output
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

function writeArtifact(dir, version) {
  const file = "getpaseo-hub-" + version + ".tgz";
  writeFileSync(join(dir, file), "artifact");
  writeFileSync(join(dir, file + ".sha256"), checksum + "  " + file + "\n");
}

test("holds the legacy cutover without migration or per-commit scans", (t) => {
  const { dir, run, push, git, save } = fixture(t);
  git("update-ref", "refs/tags/v0.11.0", git("rev-parse", "HEAD"));
  git("update-ref", "-d", "refs/tags/v1.0.0");
  push("first fix");
  save("scripts/cd/check-migrations.mjs", 'throw new Error("unexpected scan");');
  const first = plan(run, { RELEASES: "[]" });
  assert.deepEqual(first, {
    ship: "true",
    base_tag: "v0.11.0",
    version: "1.0.0",
    held: "true",
    hold_reason: "legacy-baseline",
  });
  assert.equal(readFileSync(join(dir, "gh-calls"), "utf8").trim().split("\n").length, 1);
  assert.match(readFileSync(join(dir, "gh-calls"), "utf8"), /\/releases\?/u);
});

test("push path classification includes changes from prior pushes since the newest reachable tag", (t) => {
  const { dir, push, git, save } = fixture(t);
  mkdirSync(join(dir, "src/e2e"));
  save("src/card.tsx", "ui change");
  save("src/e2e/contract.ts", "e2e change");
  const previous = push("previous push");
  git("update-ref", "refs/tags/v9.0.0-rc.1", previous);
  const tip = push("latest push");
  git("update-ref", "refs/tags/v10.0.0", push("unreachable push"));
  git("checkout", "--detach", tip);
  const classify = () =>
    execFileSync("node", ["scripts/cd/changed-paths.mjs", previous, "true"], {
      cwd: dir,
      encoding: "utf8",
    });
  assert.equal(classify(), "ui=true\ne2e=true\nworkflows=false\n");
  git("update-ref", "-d", "refs/tags/v1.0.0");
  assert.equal(classify(), "ui=false\ne2e=false\nworkflows=false\n");
});

test("two successive main pushes plan against the previous publish and tag their tested SHAs", (t) => {
  const workflow = readFileSync(join(root, ".github/workflows/main.yml"), "utf8");
  assert.match(
    workflow,
    /^concurrency:\n  group: .*'push'.*'refs\/heads\/main'.*'release-main'.*\n  cancel-in-progress: false$/mu,
  );
  const { dir, run, push, git } = fixture(t);
  const targets = [];
  for (const [i, baseTag] of ["v1.0.0", "v1.0.1"].entries()) {
    const target = push("push " + i);
    targets.push(target);
    const { version, base_tag } = plan(run);
    assert.equal(base_tag, baseTag);
    assert.equal(version, "1.0." + (i + 1));
    writeArtifact(dir, version);
    const publish = (overrides) =>
      run("package", ["publish", version, dir], {
        BASE_TAG: base_tag,
        HELD: "false",
        ...overrides,
      });
    assert.notEqual(publish({ GITHUB_SHA: git("rev-parse", "HEAD^") }).status, 0);
    assert.notEqual(publish({ BASE_TAG: "" }).status, 0);
    assert.notEqual(publish({ EXPECTED_CHECKSUM: "b".repeat(64) }).status, 0);
    const result = publish({});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("rev-parse", "v" + version), target);
  }
  const calls = readFileSync(join(dir, "published"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls.map((args) => args[args.indexOf("--target") + 1]),
    targets,
  );
  git("checkout", "--detach", targets[0]);
  const stale = run("package", ["publish", "1.0.1", dir], { BASE_TAG: "v1.0.0", HELD: "false" });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /rerun packaging/u);
});

test("carries a migration hold across real tags until the prerelease is promoted", (t) => {
  const { dir, run, push, save, git } = fixture(t);
  mkdirSync(join(dir, "drizzle"));
  save("drizzle/0000.sql", "ALTER TABLE x DROP COLUMN y;");
  push("migration", "fix: destructive migration");
  const first = plan(run);
  assert.equal(first.held, "true");
  writeArtifact(dir, first.version);
  const held = run("package", ["publish", first.version, dir], {
    BASE_TAG: first.base_tag,
    HELD: first.held,
  });
  assert.equal(held.status, 0, held.stderr);
  assert.match(readFileSync(join(dir, "published"), "utf8"), /--prerelease/u);
  push("another fix");
  const listing = (prerelease) =>
    JSON.stringify([
      { tag_name: "v1.0.0", draft: false, prerelease: false },
      { tag_name: "v1.0.1", draft: false, prerelease },
    ]);
  assert.equal(git("tag", "--points-at", "HEAD^"), "v1.0.1");
  assert.equal(plan(run, { RELEASES: listing(true) }).held, "true");
  assert.equal(plan(run, { RELEASES: listing(false) }).held, "false");
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

test("alerts link the short SHA and dedupe checks and paused prechecks against the last bot comment", (t) => {
  const { dir, run, push } = fixture(t);
  const sha = push("fix");
  const runUrl = "https://github.com/skevetter/hub/actions/runs/123";
  const comment = (...args) =>
    readFileSync(join(dir, "comments"), "utf8")
      .trim()
      .split("\n")
      .at(...args);
  const notify = (outcome, previous = [], env = {}) => {
    const result = run("notify", ["Hub CD needs attention", runUrl, outcome], {
      PREVIOUS_COMMENTS: JSON.stringify(previous),
      ...env,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const bot = (body) => ({ body, user: { login: "github-actions[bot]" } });
  notify("check-failed");
  const first = comment(-1);
  assert.ok(
    first.includes(`[\`${sha.slice(0, 7)}\`](https://github.com/skevetter/hub/commit/${sha})`),
  );
  assert.match(first, /Required checks failed/u);
  notify("check-failed", [bot(first)]);
  notify("paused-precheck", [bot(first)]);
  assert.equal(readFileSync(join(dir, "comments"), "utf8"), first + "\n");
  notify("paused-precheck", [bot(first), bot("different SHA")]);
  assert.match(comment(-1), /CD is paused/u);
  notify("held", [], { VERSION: "1.0.0", HOLD_REASON: "legacy-baseline" });
  assert.match(
    comment(-1),
    /first release after the legacy baseline.*cd-control status.*selftest.*unpause.*main\.yml/u,
  );
});

test("dispatch requires a main ancestor, one tag, green CI, and a matching bot release", (t) => {
  const { run, push, git } = fixture(t);
  git("update-ref", "refs/tags/v1.0.1", push("dispatch"));
  const guard = (overrides, listing = release()) =>
    run("dispatch", [], { RELEASE: JSON.stringify(listing), ...overrides });
  const good = guard({});
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.output, `version=1.0.1\nchecksum=${checksum}\nprerelease=true\n`);
  for (const item of [
    { DEPLOY_SHA: "a".repeat(40) },
    { JOBS: JSON.stringify(jobs("required", "success")) },
    { JOBS: JSON.stringify(jobs("check / required", "failure")) },
    { BAD_ARTIFACT: "yes" },
    { BAD_ATTESTATION: "yes" },
    { BAD_CHECKSUM: "yes" },
  ]) {
    assert.notEqual(guard(item).status, 0, JSON.stringify(item));
  }
  const target = git("rev-parse", "HEAD");
  git("tag", "-d", "v1.0.1");
  assert.notEqual(guard({}).status, 0);
  git("update-ref", "refs/tags/v1.0.1", target);
  git("update-ref", "refs/tags/v1.0.2", target);
  assert.notEqual(guard({}).status, 0);
  git("tag", "-d", "v1.0.2");
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
