import { agentStep } from "../../config/compiler.js";
import { agentRun } from "../configuration/schema.js";
import { describe, expect, it } from "vitest";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  TriggerDocumentError,
} from "../configuration/index.js";
import {
  describeTriggerEvent,
  mergeTriggerForm,
  patchTriggerYaml,
  projectTriggerForm,
} from "../configuration/editor.js";
import { EDITOR_EVENTS, eventDefinition } from "../configuration/events.js";
import { summarizeTrigger } from "../../projects/activity-summary.js";
import { notificationYaml } from "./test-fixture.js";
import { documentRun } from "../configuration/steps.js";

const FILTERED = `# poll my mentions
${notificationYaml("webapp-mentions", "      repo: acme/webapp\n      reason: mention\n      contains: deploy\n")}`;

describe("github.notification configuration", () => {
  it("is a connectionless Hub event the dashboard lists", () => {
    expect(EDITOR_EVENTS).toContain("github.notification");
    expect(eventDefinition("github.notification")).toMatchObject({
      provider: "github_notification",
      origin: "hub",
      label: "GitHub notification",
    });
  });

  it("compiles repo and reason filters with no allowlist and no reply output", () => {
    const [event] = compileTriggerDocument(FILTERED).events;
    expect(event!.on).toBe("github.notification");
    expect(event!.filters).toEqual({
      repo: "acme/webapp",
      reason: "mention",
      contains: "deploy",
    });
    expect(agentStep(event!.steps[0]).allowOutputs).toEqual([]);
  });

  it("fails closed on from_users, connection and filters the poll cannot evaluate", () => {
    const issues = (yaml: string) => {
      try {
        parseTriggerDocument(yaml);
      } catch (error) {
        if (error instanceof TriggerDocumentError) return error.issues;
        throw error;
      }
      return [];
    };
    expect(issues(notificationYaml("a", '      from_users: ["octocat"]\n'))).toEqual([
      {
        path: ["on", "github.notification", "filters", "from_users"],
        message:
          "github.notification has no commenter or author, so it does not accept from_users.",
      },
    ]);
    expect(issues(notificationYaml("a", '      from_users: ["*"]\n'))).toHaveLength(1);
    expect(issues(notificationYaml("a", "      exclude_contains: wip\n"))[0]!.message).toContain(
      "repo, reason, contains, pattern",
    );
    expect(
      issues(notificationYaml("a").replace("{}", "\n    connection: company-github")),
    ).toHaveLength(1);
    expect(issues(FILTERED)).toEqual([]);
  });

  it("rejects from_users on the compiled path too", async () => {
    const { compileHubConfig } = await import("../../config/compiler.js");
    const environment = {
      name: "target",
      kind: "daemon" as const,
      daemon: "devbox",
      cwd: "/workspace",
    };
    expect(() =>
      compileHubConfig({
        environments: [environment],
        triggers: [
          {
            name: "poll",
            on: "github.notification",
            max_runtime: "1h",
            filters: { from_users: ["octocat"] },
            steps: [
              {
                id: "run",
                environment: "target",
                max_runtime: "1h",
                idle_timeout: "10m",
                agent: { provider: "codex", mode: "full-access" },
                prompt: [{ text: "go" }],
                auto_archive: true,
                background: false,
              },
            ],
          },
        ],
      }),
    ).toThrow("github.notification has no commenter or author");
  });

  it("accepts reason only on github.notification", () => {
    const manual = FILTERED.replace("github.notification", "slack.mention").replace(
      "    filters:",
      "    connection: acme-slack\n    filters:\n      from_users: ['*']",
    );
    expect(() => parseTriggerDocument(manual)).toThrow("reason is only supported");
  });

  it("round trips repo and reason filters through the form editor", () => {
    const projection = projectTriggerForm(FILTERED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value.event).toBe("github.notification");
    expect(patchTriggerYaml(FILTERED, projection.value)).toBe(FILTERED);

    const edited = patchTriggerYaml(FILTERED, {
      ...projection.value,
      name: "renamed",
      steps: projection.value.steps.map((step, index) =>
        index === 0 ? { ...step, prompt: "Changed." } : step,
      ),
    });
    expect(edited).toContain("# poll my mentions");
    const document = parseTriggerDocument(edited);
    expect(document.name).toBe("renamed");
    expect(document.on["github.notification"]).toEqual({
      filters: { repo: "acme/webapp", reason: "mention", contains: "deploy" },
    });
    expect(agentRun(documentRun(parseTriggerDocument(edited))).prompt).toBe("Changed.");

    const merged = mergeTriggerForm(FILTERED, { ...projection.value, cwd: "/elsewhere" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(parseTriggerDocument(merged.yaml).on["github.notification"]!.filters).toMatchObject({
      repo: "acme/webapp",
      reason: "mention",
    });
  });

  it("creates a new notification trigger without a connection or allowlist", () => {
    const projection = projectTriggerForm(notificationYaml("fresh"));
    if (projection.status !== "editable") throw new Error(projection.reason);
    const created = mergeTriggerForm("", { ...projection.value, name: "created" });
    if (created.status !== "ok") throw new Error(created.reason);
    expect(parseTriggerDocument(created.yaml).on).toEqual({ "github.notification": {} });
    expect(describeTriggerEvent(projection.value, "github.notification")).toEqual({
      kind: "GitHub notification",
    });
  });

  it("summarizes a notification for the activity list", () => {
    expect(
      summarizeTrigger("github.notification", {
        github_notification: {
          repo: "acme/webapp",
          title: "Fix the flaky deploy check",
          html_url: "https://github.com/acme/webapp/pull/42",
        },
      }),
    ).toEqual({
      provider: "github_notification",
      headline: "acme/webapp: Fix the flaky deploy check",
      actor: null,
      externalUrl: "https://github.com/acme/webapp/pull/42",
    });
    expect(summarizeTrigger("github.notification", {}).headline).toBe("GitHub notification");
  });
});
