import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readRunProgressSettings, type RunProgressSettings } from "./settings.js";

const integerSettings = [
  ["PASEO_HUB_TIMELINE_MAX_EVENTS", "timelineMaxEvents", 500, 50, 5000],
  ["PASEO_HUB_TIMELINE_RETENTION_DAYS", "retentionDays", 30, 1, 365],
  ["PASEO_HUB_PROGRESS_MIN_EDIT_SECONDS", "minEditSeconds", 20, 5, 600],
  ["PASEO_HUB_PROGRESS_MAX_EDITS", "maxEdits", 120, 10, 1000],
  ["PASEO_HUB_STREAM_MAX_PER_KEY", "streamMaxPerKey", 5, 1, 100],
  ["PASEO_HUB_STREAM_MAX_PER_ORG", "streamMaxPerOrg", 20, 1, 500],
  ["PASEO_HUB_STREAM_MAX_TOTAL", "streamMaxTotal", 200, 1, 2000],
  ["PASEO_HUB_STREAM_HEARTBEAT_SECONDS", "streamHeartbeatSeconds", 15, 5, 60],
  ["PASEO_HUB_STREAM_MAX_SECONDS", "streamMaxSeconds", 3600, 60, 86400],
] as const satisfies readonly (readonly [
  string,
  keyof RunProgressSettings,
  number,
  number,
  number,
])[];

const booleanSettings = [
  ["PASEO_HUB_RUN_TIMELINE", "runTimelineEnabled"],
  ["PASEO_HUB_RUN_STREAM", "runStreamEnabled"],
  ["PASEO_HUB_PROGRESS_MESSAGES", "progressMessagesEnabled"],
] as const;

const token = "github-secret-do-not-echo";

function rejectsWithoutValue(environment: Record<string, string>, variable: string): void {
  assert.throws(
    () => readRunProgressSettings(environment),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(variable));
      assert.ok(!error.message.includes(token));
      assert.ok(!error.stack?.includes(token));
      return true;
    },
  );
}

function registerIntegerTests(): void {
  for (const [variable, property, fallback, min, max] of integerSettings) {
    for (const value of [undefined, "", "   "]) {
      it(`keeps the default for ${JSON.stringify(value)}`, () => {
        assert.equal(readRunProgressSettings({ [variable]: value })[property], fallback);
      });
    }
    for (const value of [min, max]) {
      it(`accepts the boundary ${value} with every switch off`, () => {
        assert.equal(readRunProgressSettings({ [variable]: String(value) })[property], value);
      });
    }
    it("accepts trimmed whole numbers and leading zeroes", () => {
      assert.equal(readRunProgressSettings({ [variable]: ` 00${min} ` })[property], min);
    });
    for (const value of [
      String(min - 1),
      String(max + 1),
      "-1",
      "+50",
      "50.0",
      "5e1",
      "0x32",
      "NaN",
      "Infinity",
      "50ms",
      "5 0",
      "9007199254740992",
      "9".repeat(400),
    ]) {
      it(`rejects ${value} with every switch off`, () => {
        assert.throws(() => readRunProgressSettings({ [variable]: value }), {
          message: `${variable} must be a whole number from ${min} to ${max}.`,
        });
      });
    }
  }
}

function registerBooleanTests(): void {
  for (const [variable, property] of booleanSettings) {
    for (const value of [undefined, "", "false"]) {
      it(`disables for ${JSON.stringify(value)}`, () => {
        const environment = { PASEO_HUB_RUN_TIMELINE: "true", [variable]: value };
        assert.equal(readRunProgressSettings(environment)[property], false);
      });
    }
    it("enables for true", () => {
      assert.equal(
        readRunProgressSettings({ PASEO_HUB_RUN_TIMELINE: "true", [variable]: "true" })[property],
        true,
      );
    });
    for (const value of [
      "TRUE",
      "FALSE",
      "1",
      "0",
      "yes",
      "false,true",
      "   ",
      " true",
      "false ",
    ]) {
      it(`rejects ${value}`, () => {
        assert.throws(() => readRunProgressSettings({ [variable]: value }), {
          message: `${variable} must be true or false.`,
        });
      });
    }
  }
}

describe("run progress settings", () => {
  it("defaults to disabled capture, streams and reporters with retention enabled", () => {
    assert.deepEqual(readRunProgressSettings({}), {
      runTimelineEnabled: false,
      runStreamEnabled: false,
      progressMessagesEnabled: false,
      githubOrgs: {},
      publicRepos: "refuse",
      timelineMaxEvents: 500,
      retentionDays: 30,
      minEditSeconds: 20,
      maxEdits: 120,
      streamMaxPerKey: 5,
      streamMaxPerOrg: 20,
      streamMaxTotal: 200,
      streamHeartbeatSeconds: 15,
      streamMaxSeconds: 3600,
    });
  });

  registerIntegerTests();

  registerBooleanTests();

  for (const variable of ["PASEO_HUB_RUN_STREAM", "PASEO_HUB_PROGRESS_MESSAGES"]) {
    for (const timeline of [undefined, "", "false"]) {
      it(`${variable} needs the timeline when it is ${JSON.stringify(timeline)}`, () => {
        assert.throws(
          () => readRunProgressSettings({ [variable]: "true", PASEO_HUB_RUN_TIMELINE: timeline }),
          { message: `${variable} needs PASEO_HUB_RUN_TIMELINE=true.` },
        );
      });
    }
  }

  it("accepts all switches enabled together", () => {
    const settings = readRunProgressSettings({
      PASEO_HUB_RUN_TIMELINE: "true",
      PASEO_HUB_RUN_STREAM: "true",
      PASEO_HUB_PROGRESS_MESSAGES: "true",
    });
    assert.equal(settings.runTimelineEnabled, true);
    assert.equal(settings.runStreamEnabled, true);
    assert.equal(settings.progressMessagesEnabled, true);
  });

  it("validates numeric settings before checking switch dependencies", () => {
    assert.throws(
      () =>
        readRunProgressSettings({
          PASEO_HUB_RUN_STREAM: "true",
          PASEO_HUB_STREAM_MAX_SECONDS: "invalid",
        }),
      /PASEO_HUB_STREAM_MAX_SECONDS/u,
    );
  });

  for (const value of [undefined, "", " ", "refuse", "allow"]) {
    it(`accepts public repository policy ${JSON.stringify(value)}`, () => {
      assert.equal(
        readRunProgressSettings({ PASEO_HUB_PROGRESS_PUBLIC_REPOS: value }).publicRepos,
        value === "allow" ? "allow" : "refuse",
      );
    });
  }

  for (const value of ["ALLOW", "true", "false", "deny", "refused"]) {
    it(`rejects public repository policy ${value} while disabled`, () => {
      assert.throws(() => readRunProgressSettings({ PASEO_HUB_PROGRESS_PUBLIC_REPOS: value }), {
        message: "PASEO_HUB_PROGRESS_PUBLIC_REPOS must be refuse or allow.",
      });
    });
  }

  it("trims the token and accepts mappings before the token is set", () => {
    const mapping = "team:Owner/Repo,Other/*;team-two:Owner/repo.name_1-2";
    assert.deepEqual(
      readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_ORGS: mapping }).githubOrgs,
      { team: ["owner/repo", "other/*"], "team-two": ["owner/repo.name_1-2"] },
    );
    assert.equal(
      readRunProgressSettings({
        PASEO_HUB_PROGRESS_GITHUB_TOKEN: ` ${token}\n`,
        PASEO_HUB_PROGRESS_GITHUB_ORGS: mapping,
      }).githubToken,
      token,
    );
  });

  for (const value of [undefined, "", " \n "]) {
    it(`treats token ${JSON.stringify(value)} as unset`, () => {
      const settings = readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_TOKEN: value });
      assert.equal(settings.githubToken, undefined);
      assert.ok(!Object.hasOwn(settings, "githubToken"));
    });
    it(`requires a mapping when the token is set and mapping is ${JSON.stringify(value)}`, () => {
      assert.throws(
        () =>
          readRunProgressSettings({
            PASEO_HUB_PROGRESS_GITHUB_TOKEN: token,
            PASEO_HUB_PROGRESS_GITHUB_ORGS: value,
          }),
        {
          message: "PASEO_HUB_PROGRESS_GITHUB_TOKEN needs PASEO_HUB_PROGRESS_GITHUB_ORGS.",
        },
      );
    });
  }

  it("does not include the token in a missing mapping error", () => {
    rejectsWithoutValue(
      { PASEO_HUB_PROGRESS_GITHUB_TOKEN: token },
      "PASEO_HUB_PROGRESS_GITHUB_TOKEN",
    );
  });

  const malformedMappings = [
    "team",
    ":owner/repo",
    "team:",
    "Team:owner/repo",
    "-team:owner/repo",
    "team_name:owner/repo",
    "team:owner",
    "team:/repo",
    "team:owner/",
    "team:owner/repo/extra",
    "team:*/repo",
    "team:owner/repo*",
    "team:owner/**",
    "team:owner/repo,",
    "team:,owner/repo",
    "team:owner/repo,,owner/other",
    "team:owner/repo;",
    ";team:owner/repo",
    "team:owner/repo;;other:owner/repo",
    "team :owner/repo",
    "team: owner/repo",
    "team:owner/repo, owner/other",
    "team:owner/repo; other:owner/repo",
    "team:owner/repo:extra",
    "team:owner/repo?query",
    "team:owner/r\u00e9po",
    "team:owner/repo\nother:owner/repo",
    "team:owner/repo\n;other:owner/repo",
    "team:owner/repo\r;other:owner/repo",
    "team:owner/repo\r\n;other:owner/repo",
    "team:owner/repo\u2028;other:owner/repo",
    "team:owner/repo\u2029;other:owner/repo",
  ];
  for (const value of malformedMappings) {
    it(`rejects malformed mapping ${JSON.stringify(value)} with every switch off`, () => {
      assert.throws(
        () => readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_ORGS: value }),
        /PASEO_HUB_PROGRESS_GITHUB_ORGS entry \d+:/u,
      );
    });
  }

  it("reports the failing mapping entry without its content", () => {
    assert.throws(
      () => readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_ORGS: `team:owner/repo;${token}` }),
      { message: "PASEO_HUB_PROGRESS_GITHUB_ORGS entry 2: expected slug:owner/name,owner/*." },
    );
  });

  it("rejects duplicate slugs rather than replacing or widening permissions", () => {
    assert.throws(
      () =>
        readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_ORGS: "team:owner/one;team:owner/*" }),
      { message: "PASEO_HUB_PROGRESS_GITHUB_ORGS entry 2: duplicate organization slug." },
    );
  });

  it("handles object property names as organization slugs", () => {
    const mapping = readRunProgressSettings({
      PASEO_HUB_PROGRESS_GITHUB_ORGS: "constructor:owner/repo;prototype:owner/*",
    }).githubOrgs;
    assert.equal(Object.hasOwn(mapping, "constructor"), true);
    assert.deepEqual(mapping.constructor, ["owner/repo"]);
    assert.deepEqual(mapping["prototype"], ["owner/*"]);
  });

  it("accepts twenty organizations and one hundred patterns", () => {
    const patterns = Array.from({ length: 5 }, (_, pattern) => `owner/repo-${pattern}`).join(",");
    const mapping = Array.from({ length: 20 }, (_, index) => `team-${index}:${patterns}`).join(";");
    const settings = readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_ORGS: mapping });
    assert.equal(Object.keys(settings.githubOrgs).length, 20);
    assert.equal(Object.values(settings.githubOrgs).flat().length, 100);
  });

  it("rejects the twenty-first organization", () => {
    const mapping = Array.from({ length: 21 }, (_, index) => `team-${index}:owner/repo`).join(";");
    assert.throws(() => readRunProgressSettings({ PASEO_HUB_PROGRESS_GITHUB_ORGS: mapping }), {
      message: "PASEO_HUB_PROGRESS_GITHUB_ORGS entry 21: at most 20 organizations are allowed.",
    });
  });

  it("rejects the hundred-and-first pattern across organizations", () => {
    const patterns = Array.from({ length: 50 }, (_, index) => `owner/repo-${index}`).join(",");
    assert.throws(
      () =>
        readRunProgressSettings({
          PASEO_HUB_PROGRESS_GITHUB_ORGS: `first:${patterns};second:${patterns};third:owner/extra`,
        }),
      {
        message:
          "PASEO_HUB_PROGRESS_GITHUB_ORGS entry 3: at most 100 repository patterns are allowed.",
      },
    );
  });

  it("counts duplicate patterns toward the pattern cap", () => {
    const patterns = Array.from({ length: 101 }, () => "owner/repo").join(",");
    assert.throws(
      () =>
        readRunProgressSettings({
          PASEO_HUB_PROGRESS_GITHUB_ORGS: `team:${patterns}`,
        }),
      /PASEO_HUB_PROGRESS_GITHUB_ORGS entry 1: at most 100 repository patterns/u,
    );
  });

  it("never echoes secret values through any settings error", () => {
    const variables = [
      ...integerSettings.map(([variable]) => variable),
      ...booleanSettings.map(([variable]) => variable),
      "PASEO_HUB_PROGRESS_GITHUB_ORGS",
      "PASEO_HUB_PROGRESS_PUBLIC_REPOS",
    ];
    for (const variable of variables) {
      rejectsWithoutValue(
        {
          PASEO_HUB_PROGRESS_GITHUB_TOKEN: token,
          PASEO_HUB_PROGRESS_GITHUB_ORGS: "team:owner/repo",
          [variable]: token,
        },
        variable,
      );
    }
  });
});
