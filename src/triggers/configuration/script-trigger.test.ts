import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isScriptStep, parseCompiledHubConfig } from "../../config/compiler.js";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";
import { isScriptRun } from "./schema.js";

const NOTIFICATION = `
name: build-on-review
on:
  github.notification:
    filters:
      repo: acme/webapp
      reason: review_requested
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: |
    npm ci
    npm test
`;

function slack(extra = ""): string {
  return `
name: deploy-from-chat
on:
  slack.mention:
    connection: acme-slack
    filters:
      from_users: [U0BNGPZEXT2]
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./deploy.sh
${extra}`;
}

function issues(yaml: string): { path: string; message: string }[] {
  try {
    compileTriggerDocument(yaml);
  } catch (error) {
    if (error instanceof TriggerDocumentError) {
      return error.issues.map(({ path, message }) => ({ path: path.join("."), message }));
    }
    throw error;
  }
  return [];
}

describe("script actions in a trigger document", () => {
  it("parses a script run with the script default runtime", () => {
    const document = parseTriggerDocument(NOTIFICATION);
    assert.ok(isScriptRun(document.run));
    assert.equal(document.run.script, "npm ci\nnpm test\n");
    assert.equal(document.run.max_runtime, "10m");
    assert.deepEqual(document.run.target, { daemon: "devbox", cwd: "/workspace/webapp" });
  });

  it("compiles to one script step with no agent, prompt, or continuation", () => {
    const compiled = compileTriggerDocument(NOTIFICATION);
    const [event] = compiled.events;
    assert.ok(event);
    assert.equal(event.steps.length, 1);
    const [step] = event.steps;
    assert.ok(step && isScriptStep(step));
    assert.deepEqual(step, {
      kind: "script",
      id: "run",
      environment: "target",
      maxRuntimeMs: 600_000,
      script: "npm ci\nnpm test\n",
    });
    assert.equal(event.maxRuntimeMs, 600_000);
  });

  it("keeps the compiled script step through the stored contract", () => {
    const compiled = compileTriggerDocument(NOTIFICATION);
    const environment = { ...compiled.environment, daemonId: "daemon-1" };
    const config = { environments: [environment], triggers: compiled.events };
    const serialized = JSON.stringify(config);
    const reparsed = parseCompiledHubConfig(JSON.parse(serialized));
    assert.deepEqual(reparsed.triggers, compiled.events);
    const revision: ProjectConfigurationRevisionRecord = {
      id: "revision",
      projectId: "project",
      organizationId: "org",
      version: 1,
      sourceKind: "manual",
      sourceEvidence: { kind: "organization_trigger_adapter" },
      rawYaml: NOTIFICATION,
      normalizedConfiguration: config,
      validationErrors: null,
      contentHash: "original",
      createdByUserId: "user",
      receivedAt: null,
      createdAt: new Date(),
      validatedAt: new Date(),
    };
    // A script has no continuation to default in.
    const [step] = parseProjectConfiguration(revision).triggers[0]?.steps ?? [];
    assert.ok(step && isScriptStep(step));
    assert.equal("continuation" in step, false);
  });

  it("honors an authored script max_runtime", () => {
    const compiled = compileTriggerDocument(
      NOTIFICATION.replace("  script: |", "  max_runtime: 45s\n  script: |"),
    );
    assert.equal(compiled.events[0]?.steps[0]?.maxRuntimeMs, 45_000);
  });

  it("round-trips through serialization", () => {
    const document = parseTriggerDocument(NOTIFICATION);
    assert.deepEqual(parseTriggerDocument(serializeTriggerDocument(document)), document);
  });

  it("requires an action", () => {
    const yaml = NOTIFICATION.replace(/ {2}script: \|\n( {4}.*\n)+/u, "");
    assert.match(
      issues(yaml)[0]?.message ?? "",
      /run needs an action: agent with prompt, or script/u,
    );
  });

  it("rejects a script combined with an agent or a prompt, and says to use two triggers", () => {
    const found = issues(
      slack("  agent:\n    provider: codex\n    mode: full-access\n  prompt: Do it\n"),
    );
    assert.deepEqual(found.map(({ path }) => path).sort(), ["run.agent", "run.prompt"]);
    for (const { message } of found) assert.match(message, /two triggers on the same event/u);
  });

  it.each([
    ["continuation", "  continuation:\n    mode: new\n", /no agent conversation/u],
    ["output", "  output:\n    schema:\n      type: object\n", /exit code/u],
    ["outputs", "  outputs:\n    slack.reply:\n      max: 1\n", /exit code/u],
    ["github", "  github:\n    connection: acme-github\n", /Hub mints no token/u],
    ["env", "  env:\n    A: b\n", /HUB_EVENT_JSON/u],
    ["idle_timeout", "  idle_timeout: 5m\n", /max_runtime/u],
    ["startup_timeout", "  startup_timeout: 5m\n", /max_runtime/u],
    ["title", "  title: Deploy\n", /no workspace/u],
    ["background", "  background: true\n", /no workspace/u],
    ["auto_archive", "  auto_archive: false\n", /no workspace/u],
    ["complete_on_turn_end", "  complete_on_turn_end: true\n", /no agent turn/u],
  ])("rejects %s on a script with a reason", (key, line, reason) => {
    const found = issues(slack(line));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.path, `run.${key}`);
    assert.match(found[0]?.message ?? "", new RegExp(`^${key} does not apply to a script`, "u"));
    assert.match(found[0]?.message ?? "", reason);
  });

  it("rejects a worktree under the target", () => {
    const found = issues(
      slack().replace(
        "    cwd: /workspace/webapp\n",
        "    cwd: /workspace/webapp\n    worktree:\n      mode: checkout-branch\n      branch: main\n",
      ),
    );
    assert.equal(found[0]?.path, "run.target.worktree");
    assert.match(found[0]?.message ?? "", /worktree does not apply to a script/u);
  });

  it("rejects a blank script", () => {
    const found = issues(slack().replace("script: ./deploy.sh", 'script: "  \\n"'));
    assert.match(found[0]?.message ?? "", /script must not be blank/u);
  });

  it("rejects an unknown field", () => {
    assert.ok(issues(slack("  mode: fast\n")).length > 0);
  });

  it("refuses a templated script, because event data is never interpolated", () => {
    const [found] = issues(slack().replace("./deploy.sh", "echo ${{ paseo.prompt }}"));
    assert.match(found?.message ?? "", /script text is not templated/u);
    assert.match(found?.message ?? "", /HUB_EVENT_JSON/u);
  });

  it("still requires prompt with an agent", () => {
    const [found] = issues(
      slack().replace(
        "  script: ./deploy.sh\n",
        "  agent:\n    provider: codex\n    mode: full-access\n",
      ),
    );
    assert.equal(found?.path, "run.prompt");
  });
});

describe("script action launch guardrails", () => {
  it.each(["slack.mention", "discord.mention", "github.issue_comment", "linear.comment_created"])(
    "refuses a wildcard audience on %s",
    (event) => {
      const connection = event.split(".")[0];
      const found = issues(`
name: wild
on:
  ${event}:
    connection: acme-${connection}
    filters:
      from_users: ["*"]
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./deploy.sh
`);
      assert.match(found[0]?.message ?? "", /needs filters\.from_users that names the people/u);
      assert.match(found[0]?.message ?? "", /wildcard or empty list/u);
    },
  );

  it("refuses an audience that mixes a wildcard with names", () => {
    const found = issues(slack().replace("[U0BNGPZEXT2]", '[U0BNGPZEXT2, "*"]'));
    assert.match(found[0]?.message ?? "", /needs filters\.from_users/u);
  });

  it("still lets an agent prompt run for everyone on the same event", () => {
    const yaml = slack()
      .replace("[U0BNGPZEXT2]", '["*"]')
      .replace(
        "  script: ./deploy.sh\n",
        "  agent:\n    provider: codex\n    mode: full-access\n  prompt: hi\n",
      );
    assert.deepEqual(issues(yaml), []);
  });

  it.each([
    ["no audience", "  manual.run: {}\n"],
    ["a wildcard audience", '  manual.run:\n    filters:\n      from_users: ["*"]\n'],
  ])("refuses a manual script with %s", (_, on) => {
    const found = issues(`
name: run-it
on:
${on}run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./deploy.sh
`);
    assert.match(found[0]?.message ?? "", /needs filters\.from_users that names/u);
  });

  it("accepts a manual script with a named key actor", () => {
    assert.deepEqual(
      issues(`
name: run-it
on:
  manual.run:
    filters:
      from_users: [sender]
run:
  target: { daemon: devbox, cwd: /workspace/webapp }
  script: ./deploy.sh
`),
      [],
    );
  });

  it("refuses manual.run for a script when it shares a document with a safe event", () => {
    const found = issues(`
name: two
on:
  schedule.tick:
    recurrence:
      start: "2026-09-09T02:00:00"
      rule: "FREQ=DAILY"
      timezone: Europe/Berlin
  manual.run: {}
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./nightly.sh
`);
    assert.match(found[0]?.message ?? "", /needs filters\.from_users that names/u);
  });

  it("allows a manual run agent prompt without an audience, as before", () => {
    assert.deepEqual(
      issues(`
name: run-it
on:
  manual.run: {}
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  agent:
    provider: codex
    mode: full-access
  prompt: hi
`),
      [],
    );
  });

  function notificationDocument(filters: string): string {
    return `
name: filtered
on:
  github.notification:
    filters:
${filters}
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./deploy.sh
`;
  }

  it.each([
    ["no filters", "      {}"],
    ["only a repo", "      repo: acme/webapp"],
    ["only a reason", "      reason: review_requested"],
    ["a contains filter alone", "      contains: urgent"],
  ])("requires both repo and reason on a notification script, got %s", (_, filters) => {
    const document =
      filters === "      {}"
        ? notificationDocument("").replace("    filters:\n\n", "    {}\n")
        : notificationDocument(filters);
    const found = issues(document);
    assert.match(found[0]?.message ?? "", /Set both filters\.repo and filters\.reason/u);
    assert.match(found[0]?.message ?? "", /no actor to allowlist/u);
    assert.match(
      found[0]?.message ?? "",
      /author, assign, review_requested, state_change, ci_activity/u,
    );
  });

  it.each(["author", "assign", "review_requested", "state_change", "ci_activity"])(
    "accepts the %s notification reason with a repo",
    (reason) => {
      assert.deepEqual(
        issues(notificationDocument(`      repo: acme/webapp\n      reason: ${reason}`)),
        [],
      );
    },
  );

  it.each([
    "mention",
    "team_mention",
    "comment",
    "subscribed",
    "manual",
    "security_alert",
    "Author",
  ])("refuses the %s notification reason, because a third party can cause it", (reason) => {
    const found = issues(notificationDocument(`      repo: acme/webapp\n      reason: ${reason}`));
    assert.match(
      found[0]?.message ?? "",
      new RegExp(`filters\\.reason "${reason}" is not allowed`, "u"),
    );
    assert.match(found[0]?.message ?? "", /Third parties can cause mention/u);
  });

  it("still lets an agent prompt run on every notification reason", () => {
    const yaml = notificationDocument("      reason: mention").replace(
      "  script: ./deploy.sh\n",
      "  agent:\n    provider: codex\n    mode: full-access\n  prompt: hi\n",
    );
    assert.deepEqual(issues(yaml), []);
  });

  it("allows a schedule script with no audience", () => {
    assert.deepEqual(
      issues(`
name: nightly
on:
  schedule.tick:
    recurrence:
      start: "2026-09-09T02:00:00"
      rule: "FREQ=DAILY"
      timezone: Europe/Berlin
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./nightly.sh
`),
      [],
    );
  });

  it("applies the guardrail to every event a script trigger listens on", () => {
    const found = issues(`
name: two-events
on:
  github.notification:
    filters:
      repo: acme/webapp
      reason: author
  slack.mention:
    connection: acme-slack
    filters:
      from_users: ["*"]
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: ./deploy.sh
`);
    assert.match(found[0]?.message ?? "", /slack\.mention needs filters\.from_users/u);
  });
});

describe("script text limits", () => {
  const withScript = (script: string) =>
    slack().replace("  script: ./deploy.sh\n", `  script: ${JSON.stringify(script)}\n`);

  it("refuses a NUL byte in the script", () => {
    const found = issues(withScript("echo a\u0000b"));
    assert.match(found[0]?.message ?? "", /must not contain NUL bytes/u);
  });

  it("accepts a script of exactly 64 KiB and refuses one byte more", () => {
    assert.deepEqual(issues(withScript("#".repeat(64 * 1024))), []);
    const found = issues(withScript("#".repeat(64 * 1024 + 1)));
    assert.match(found[0]?.message ?? "", /at most 64 KiB/u);
  });

  it("counts bytes, not characters", () => {
    const found = issues(withScript("é".repeat(33 * 1024)));
    assert.match(found[0]?.message ?? "", /at most 64 KiB/u);
  });
});
