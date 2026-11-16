import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DaemonAgentStreamEvent } from "../daemons/protocol.js";
import { CAPTURED_TOOL_CALLS } from "../daemons/test-utils/tool-call-fixtures.js";
import type { TimelineProjectionInput } from "./capture-types.js";
import { projectTimelineEvent } from "./project.js";
import { createTimelineScrubber } from "./scrub.js";
import { TIMELINE_KINDS } from "./store.js";
import { USERINFO_SCHEMES, USERINFO_WHITESPACE_CASES } from "./test-utils/userinfo-fixtures.js";
import {
  BENIGN_URL_CASES,
  hasParsedUserinfo,
  URL_USERINFO_CANDIDATES,
  URL_USERINFO_CASES,
  URL_USERINFO_SCHEMES,
  URL_USERINFO_SECRET,
} from "./test-utils/url-userinfo-fixtures.js";

const scrub = createTimelineScrubber();
const STEPS = { succeeded: 1, failed: 1, timed_out: 1, skipped: 1, not_run: 1, total: 5 };
const STEP_END: Extract<TimelineProjectionInput, { kind: "step_finished" }> = {
  kind: "step_finished",
  status: "failed",
  durationMs: 250,
};
const RUN_END: Extract<TimelineProjectionInput, { kind: "run_finished" }> = {
  kind: "run_finished",
  status: "failed",
  durationMs: 500,
  steps: STEPS,
  stepRowsOmitted: 0,
};
const SHORT_CREDENTIAL = ["aBcD0192", "EfGh3456", "IjKl7890"].join("");
const ESCAPED_CREDENTIAL = ["aBcD0192", '" ', "EfGh3456", "IjKl7890"].join("");

function daemon(event: DaemonAgentStreamEvent): TimelineProjectionInput {
  return { kind: "agent_event", event };
}

function tool(status: string, callId?: string): TimelineProjectionInput {
  return daemon({
    type: "timeline",
    provider: "claude",
    item: { type: "tool_call", name: "Bash", status, ...(callId === undefined ? {} : { callId }) },
  });
}

function changed(
  input: TimelineProjectionInput,
  field: string,
  value: unknown,
): TimelineProjectionInput {
  const copy = { ...input };
  Reflect.set(copy, field, value);
  return copy;
}

describe("closed stored-event projection", () => {
  it("matches fixed golden rows for all projectable kinds; truncation notices are exclusively store-owned", () => {
    const inputs: TimelineProjectionInput[] = [
      { kind: "run_started", trigger: "daily-build", steps: 5 },
      { kind: "step_started", type: "agent", agent: { provider: "claude", mode: "acceptEdits" } },
      daemon({ type: "thread_started", provider: "claude", sessionId: "not-stored" }),
      daemon({ type: "turn_started", provider: "claude" }),
      daemon({ type: "turn_completed", provider: "claude" }),
      tool("running", "call-1"),
      tool("completed", "call-1"),
      daemon({
        type: "permission_requested",
        provider: "claude",
        request: { toolName: "Read", details: "not-stored" },
      }),
      daemon({
        type: "permission_resolved",
        provider: "claude",
        requestId: "not-stored",
        resolution: { value: "not-stored" },
      }),
      daemon({ type: "turn_failed", provider: "claude", error: "connection closed" }),
      daemon({ type: "turn_canceled", provider: "claude", reason: "interrupted" }),
      {
        ...STEP_END,
        exitCode: 3,
        completion: "inferred_from_turn_end",
        failure: "script exited 3",
      },
      { ...RUN_END, failure: "agent_execution_failed", stepRowsOmitted: 1 },
    ];
    const rows = inputs.map((input) => projectTimelineEvent(input, scrub));
    expect(rows).toEqual([
      { kind: "run_started", data: { trigger: "daily-build", steps: 5 } },
      {
        kind: "step_started",
        data: { type: "agent", agent: { provider: "claude", mode: "acceptEdits" } },
      },
      { kind: "agent_started", data: { provider: "claude" } },
      { kind: "turn_started", data: {} },
      { kind: "turn_ended", data: {} },
      { kind: "tool_started", data: { tool: "Bash", category: "command", callId: "call-1" } },
      {
        kind: "tool_finished",
        data: { tool: "Bash", category: "command", callId: "call-1", status: "completed" },
      },
      { kind: "permission_requested", data: { tool: "Read" } },
      { kind: "permission_resolved", data: {} },
      { kind: "turn_failed", data: { error: "connection closed" } },
      { kind: "turn_canceled", data: { reason: "interrupted" } },
      {
        kind: "step_finished",
        data: {
          status: "failed",
          durationMs: 250,
          exitCode: 3,
          completion: "inferred_from_turn_end",
          failure: "script exited 3",
        },
      },
      {
        kind: "run_finished",
        data: {
          status: "failed",
          durationMs: 500,
          steps: STEPS,
          stepRowsOmitted: 1,
          failure: "agent_execution_failed",
        },
      },
    ]);
    expect(
      rows.map((row) => row?.kind).sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(
      TIMELINE_KINDS.filter((kind) => kind !== "truncated").sort((left, right) =>
        left.localeCompare(right),
      ),
    );
  });

  it("projects real Claude and Codex capture fixtures to fixed categories without retaining any detail", () => {
    const rows: Array<ReturnType<typeof projectTimelineEvent>> = [];
    for (const capture of CAPTURED_TOOL_CALLS) {
      for (const item of capture.items) {
        rows.push(
          projectTimelineEvent(
            daemon({ type: "timeline", provider: capture.provider, item }),
            scrub,
          ),
        );
      }
    }
    expect(rows).toEqual([
      {
        kind: "tool_finished",
        data: { tool: "Read", category: "read", callId: "fixture-claude-1", status: "completed" },
      },
      {
        kind: "tool_finished",
        data: {
          tool: "Bash",
          category: "command",
          callId: "fixture-claude-2",
          status: "completed",
        },
      },
      {
        kind: "tool_finished",
        data: { tool: "Edit", category: "edit", callId: "fixture-claude-3", status: "completed" },
      },
      {
        kind: "tool_finished",
        data: { tool: "Read", category: "read", callId: "fixture-claude-4", status: "completed" },
      },
      {
        kind: "tool_finished",
        data: {
          tool: "shell",
          category: "command",
          callId: "fixture-codex-1",
          status: "completed",
        },
      },
      {
        kind: "tool_finished",
        data: {
          tool: "shell",
          category: "command",
          callId: "fixture-codex-2",
          status: "completed",
        },
      },
      {
        kind: "tool_finished",
        data: {
          tool: "apply_patch",
          category: "edit",
          callId: "fixture-codex-3",
          status: "completed",
        },
      },
      {
        kind: "tool_finished",
        data: {
          tool: "shell",
          category: "command",
          callId: "fixture-codex-4",
          status: "completed",
        },
      },
    ]);
    for (const forbidden of [
      "detail",
      "fixture contents",
      "fixture command",
      "fixture output",
      "/fixture",
      "fixture before",
      "fixture after",
      "fixture patch",
    ]) {
      expect(JSON.stringify(rows)).not.toContain(forbidden);
    }
  });

  it.each(["completed", "failed", "canceled"])(
    "emits only tool_finished for a completed-first %s item, with or without a call id",
    (status) => {
      expect(projectTimelineEvent(tool(status, "first-seen"), scrub)?.kind).toBe("tool_finished");
      expect(projectTimelineEvent(tool(status), scrub)).toEqual({
        kind: "tool_finished",
        data: { tool: "Bash", category: "command", status },
      });
    },
  );

  it("drops running calls without a nonempty call id and rejects unknown tool status enums", () => {
    expect(projectTimelineEvent(tool("running"), scrub)).toBeUndefined();
    expect(projectTimelineEvent(tool("running", ""), scrub)).toBeUndefined();
    for (const status of ["unknown", "pending", "succeeded", "", "__proto__"]) {
      expect(projectTimelineEvent(tool(status, "call-1"), scrub)).toBeUndefined();
    }
  });

  it("drops all non-tool timeline item types and every unrelated or future daemon event", () => {
    for (const type of [
      "assistant_text",
      "reasoning",
      "user_text",
      "text",
      "test_result",
      "future_type",
    ]) {
      expect(
        projectTimelineEvent(
          daemon({
            type: "timeline",
            provider: "claude",
            item: { type, text: "private text", callId: "ignored", status: "completed" },
          }),
          scrub,
        ),
      ).toBeUndefined();
    }
    const attention: DaemonAgentStreamEvent = {
      type: "attention_required",
      provider: "claude",
      reason: "finished",
      timestamp: "ignored",
      shouldNotify: true,
    };
    expect(projectTimelineEvent(daemon(attention), scrub)).toBeUndefined();
    for (const type of ["agent_update", "agent_snapshot", "future_event"]) {
      const event = { ...attention };
      Reflect.set(event, "type", type);
      expect(projectTimelineEvent(daemon(event), scrub)).toBeUndefined();
    }
  });

  it("never passes through subjects, category claims, details, inputs, outputs, permission requests or provider extras", () => {
    const privateText = "private collaborator content";
    const inputs: TimelineProjectionInput[] = [
      daemon({
        type: "timeline",
        provider: "claude",
        text: privateText,
        item: {
          type: "tool_call",
          name: "Read",
          callId: "read-1",
          status: "completed",
          category: "web",
          subject: privateText,
          input: privateText,
          output: privateText,
          detail: { command: privateText },
          error: privateText,
        },
      }),
      daemon({
        type: "permission_requested",
        provider: "claude",
        request: { toolName: "Read", command: privateText, env: privateText },
        text: privateText,
      }),
      daemon({
        type: "turn_started",
        provider: privateText,
        text: privateText,
        reasoning: privateText,
      }),
      daemon({
        type: "permission_resolved",
        provider: "claude",
        requestId: privateText,
        resolution: { text: privateText },
      }),
    ];
    const rows = inputs.map((input) => projectTimelineEvent(input, scrub));
    expect(rows).toEqual([
      {
        kind: "tool_finished",
        data: { tool: "Read", category: "read", callId: "read-1", status: "completed" },
      },
      { kind: "permission_requested", data: { tool: "Read" } },
      { kind: "turn_started", data: {} },
      { kind: "permission_resolved", data: {} },
    ]);
    expect(JSON.stringify(rows)).not.toContain(privateText);
  });

  it.each([
    ["Bash", "command"],
    ["Read", "read"],
    ["Edit", "edit"],
    ["WebFetch", "web"],
    ["Agent", "subagent"],
    ["TodoWrite", "plan"],
    ["mcp__test__operation", "mcp"],
    ["hub / finish_execution", "finish"],
    ["unrecognized", "other"],
    ["__proto__", "other"],
  ])("derives %s category %s internally", (name, category) => {
    const row = projectTimelineEvent(
      daemon({
        type: "timeline",
        provider: "claude",
        item: { type: "tool_call", name, callId: "id", status: "running", category: "finish" },
      }),
      scrub,
    );
    expect(row?.data["category"]).toBe(category);
  });

  it("scrubs all authored string fields before name patterns and byte bounds, hashing invalid or sensitive call ids", () => {
    const secret = ["fixture", "-private", "-credential"].join("");
    const privacy = createTimelineScrubber({ scrubValues: [secret] });
    const inputs: TimelineProjectionInput[] = [
      { kind: "run_started", trigger: secret, steps: 1 },
      { kind: "step_started", type: "agent", agent: { provider: secret, mode: secret } },
      daemon({ type: "thread_started", provider: secret, sessionId: secret }),
      daemon({
        type: "timeline",
        provider: secret,
        item: { type: "tool_call", name: secret, callId: secret, status: "completed" },
      }),
      daemon({ type: "permission_requested", provider: secret, request: { toolName: secret } }),
      daemon({ type: "turn_failed", provider: secret, error: secret }),
      daemon({ type: "turn_canceled", provider: secret, reason: secret }),
      { ...STEP_END, failure: secret },
      { ...RUN_END, failure: secret },
    ];
    const rows = inputs.map((input) => projectTimelineEvent(input, privacy));
    expect(rows[0]?.data["trigger"]).toBe("[redacted]");
    expect(rows[1]?.data["agent"]).toEqual({ provider: "unknown", mode: "unknown" });
    expect(rows[3]?.data["tool"]).toBe("unnamed");
    expect(rows[3]?.data["callId"]).toBe(
      createHash("sha256").update(secret).digest("hex").slice(0, 16),
    );
    expect(rows[4]?.data).toEqual({});
    expect(JSON.stringify(rows)).not.toContain(secret);
    for (const callId of [
      "invalid call id",
      "id\n",
      "a".repeat(65),
      "\u00e9",
      "\ud800",
      ["sk", "-short"].join(""),
    ]) {
      const row = projectTimelineEvent(tool("running", callId), scrub);
      expect(row?.data["callId"]).toBe(
        createHash("sha256").update(callId).digest("hex").slice(0, 16),
      );
    }
  });

  it.each([
    {
      name: "JSON password with an escaped quote followed by whitespace",
      value: JSON.stringify({ PASSWORD: ESCAPED_CREDENTIAL }),
      secret: ESCAPED_CREDENTIAL,
    },
    {
      name: "CLI password with an escaped quote followed by whitespace",
      value: `--password=${JSON.stringify(ESCAPED_CREDENTIAL)}`,
      secret: ESCAPED_CREDENTIAL,
    },
    {
      name: "nested serialized password",
      value: JSON.stringify({ err: JSON.stringify({ PASSWORD: SHORT_CREDENTIAL }) }),
      secret: SHORT_CREDENTIAL,
    },
    ...[
      `env=PASSWORD=${["aB3d", "Ef8h", "Q2"].join("")}`,
      `[DB_PASSWORD=${["aB3d", "Ef8h", "Q2"].join("")}]`,
      `connect(password=${["aB3d", "Ef8h", "Q2"].join("")})`,
    ].map((value, index) => ({
      name: `short boundary assignment ${index}`,
      value,
      secret: ["aB3d", "Ef8h", "Q2"].join(""),
    })),
    ...[
      `--password=${SHORT_CREDENTIAL.slice(0, 8)}\\ ${SHORT_CREDENTIAL.slice(8)}`,
      `PASSWORD=${SHORT_CREDENTIAL.slice(0, 8)}\\ ${SHORT_CREDENTIAL.slice(8)}`,
      `password: ${SHORT_CREDENTIAL.slice(0, 8)} ${SHORT_CREDENTIAL.slice(8)}`,
      `password: |\n  ${SHORT_CREDENTIAL}`,
      `NORMAL=value\nPASSWORD=${SHORT_CREDENTIAL}\nNEXT=value`,
      `--password ${SHORT_CREDENTIAL}`,
    ].map((value, index) => ({
      name: `escaped or multiline password ${index}`,
      value,
      secret: SHORT_CREDENTIAL,
    })),
    {
      name: "PostgreSQL password containing an at sign",
      value: `postgres://user:ab@${["cd1234", "5678"].join("")}@host/db`,
      secret: ["ab@", "cd1234", "5678"].join(""),
    },
    ...["redis", "amqp", "ftp", "mongodb+srv", "https", "custom+app"].map((scheme) => ({
      name: `${scheme} embedded userinfo at sign`,
      value: `${scheme}://user:${SHORT_CREDENTIAL}@inside@host/db`,
      secret: SHORT_CREDENTIAL,
    })),
    {
      name: "encoded userinfo",
      value: `custom%3A%2F%2Fuser%3A${SHORT_CREDENTIAL}%40inside%40host/db`,
      secret: SHORT_CREDENTIAL,
    },
    {
      name: "encoded authority with encoded password path delimiters",
      value: `%63ustom%3a%2f%2fuser%3a${SHORT_CREDENTIAL}%2fpart%40host/db`,
      secret: SHORT_CREDENTIAL,
    },
    {
      name: "HTML encoded sensitive label",
      value: `pass&#119;ord=${SHORT_CREDENTIAL}`,
      secret: SHORT_CREDENTIAL,
    },
    {
      name: "non-key armored block",
      value: `before\n-----BEGIN PGP MESSAGE-----\n${SHORT_CREDENTIAL}\n-----END PGP MESSAGE-----\nafter`,
      secret: SHORT_CREDENTIAL,
    },
    ...["Bearer", "Basic", "Token"].flatMap((scheme) => [
      {
        name: `JSON ${scheme} Authorization`,
        value: JSON.stringify({ Authorization: `${scheme} ${SHORT_CREDENTIAL}` }),
        secret: SHORT_CREDENTIAL,
      },
      {
        name: `JSON ${scheme} Authorization with an escaped quote followed by whitespace`,
        value: JSON.stringify({ Authorization: `${scheme} ${ESCAPED_CREDENTIAL}` }),
        secret: ESCAPED_CREDENTIAL,
      },
      {
        name: `single-quoted ${scheme} Authorization`,
        value: `{'Authorization':'${scheme} ${SHORT_CREDENTIAL}'}`,
        secret: SHORT_CREDENTIAL,
      },
      {
        name: `quoted ${scheme} header value`,
        value: `Authorization: ${scheme} ${JSON.stringify(ESCAPED_CREDENTIAL)}`,
        secret: ESCAPED_CREDENTIAL,
      },
      {
        name: `bare quoted ${scheme} value`,
        value: `${scheme} ${JSON.stringify(ESCAPED_CREDENTIAL)}`,
        secret: ESCAPED_CREDENTIAL,
      },
    ]),
  ])(
    "removes every secret eight-gram from projected $name without known values or entropy",
    ({ value, secret }) => {
      expect(scrub(secret, 240)).toBe(secret);
      const inputs: { input: TimelineProjectionInput; field: string }[] = [
        { input: { kind: "run_started", trigger: value, steps: 1 }, field: "trigger" },
        {
          input: daemon({ type: "turn_failed", provider: "claude", error: value }),
          field: "error",
        },
        {
          input: daemon({ type: "turn_canceled", provider: "claude", reason: value }),
          field: "reason",
        },
        { input: { ...STEP_END, failure: value }, field: "failure" },
        { input: { ...RUN_END, failure: value }, field: "failure" },
      ];
      for (const { input, field } of inputs) {
        const row = projectTimelineEvent(input, scrub);
        const text = row?.data[field];
        expect(text).toBe("[redacted]");
        for (let index = 0; index <= secret.length - 8; index += 1) {
          const fragment = secret.slice(index, index + 8);
          expect(text).not.toContain(fragment);
          expect(JSON.stringify(row)).not.toContain(fragment);
        }
      }
    },
  );

  it.each(USERINFO_WHITESPACE_CASES)(
    "redacts the whole projected $name field across all free-text paths",
    ({ value, secret }) => {
      expect(scrub(secret, 240) === secret).toBe(true);
      const inputs: { input: TimelineProjectionInput; field: string }[] = [
        { input: { kind: "run_started", trigger: value, steps: 1 }, field: "trigger" },
        {
          input: daemon({ type: "turn_failed", provider: "claude", error: value }),
          field: "error",
        },
        {
          input: daemon({ type: "turn_canceled", provider: "claude", reason: value }),
          field: "reason",
        },
        { input: { ...STEP_END, failure: value }, field: "failure" },
        { input: { ...RUN_END, failure: value }, field: "failure" },
      ];
      for (const { input, field } of inputs) {
        const row = projectTimelineEvent(input, scrub);
        expect(row?.data[field] === "[redacted]", `whole-field marker for ${field}`).toBe(true);
        for (let index = 0; index <= secret.length - 8; index += 1) {
          expect(
            JSON.stringify(row).includes(secret.slice(index, index + 8)),
            `credential fragment retained in ${field}`,
          ).toBe(false);
        }
      }
    },
  );

  it("keeps the differential URL oracle populated for every scheme, raw mix and separator length", () => {
    expect(scrub(URL_USERINFO_SECRET, 240) === URL_USERINFO_SECRET).toBe(true);
    for (const scheme of URL_USERINFO_SCHEMES) {
      expect(
        URL_USERINFO_CASES.some((sample) => sample.scheme === scheme),
        `oracle coverage for ${scheme}`,
      ).toBe(true);
      for (let separatorLength = 0; separatorLength <= 4; separatorLength += 1) {
        const candidates = URL_USERINFO_CANDIDATES.filter(
          (sample) =>
            sample.scheme === scheme &&
            sample.separatorLength === separatorLength &&
            sample.variant === "raw" &&
            sample.credential === "password",
        );
        expect(
          new Set(candidates.map((sample) => sample.separators)).size === 2 ** separatorLength,
          `raw mix coverage for ${scheme} length ${separatorLength}`,
        ).toBe(true);
        if (scheme !== "mongodb" && scheme !== "postgres") {
          expect(
            candidates.every(({ value }) => hasParsedUserinfo(value)),
            `oracle coverage for ${scheme} length ${separatorLength}`,
          ).toBe(true);
        }
      }
    }
    for (let separatorLength = 0; separatorLength <= 4; separatorLength += 1) {
      expect(
        URL_USERINFO_CASES.some((sample) => sample.separatorLength === separatorLength),
        `oracle coverage for separator length ${separatorLength}`,
      ).toBe(true);
    }
    for (const credential of ["password", "username only", "password only"]) {
      expect(
        URL_USERINFO_CASES.some((sample) => sample.credential === credential),
        `oracle coverage for ${credential}`,
      ).toBe(true);
    }
  });

  it("redacts every oracle-confirmed differential URL across all five free-text paths", () => {
    for (const sample of URL_USERINFO_CASES) {
      const inputs: { input: TimelineProjectionInput; field: string }[] = [
        { input: { kind: "run_started", trigger: sample.value, steps: 1 }, field: "trigger" },
        {
          input: daemon({ type: "turn_failed", provider: "claude", error: sample.value }),
          field: "error",
        },
        {
          input: daemon({ type: "turn_canceled", provider: "claude", reason: sample.value }),
          field: "reason",
        },
        { input: { ...STEP_END, failure: sample.value }, field: "failure" },
        { input: { ...RUN_END, failure: sample.value }, field: "failure" },
      ];
      for (const { input, field } of inputs) {
        const row = projectTimelineEvent(input, scrub);
        expect(
          row?.data[field] === "[redacted]",
          `whole-field marker for ${sample.name} ${input.kind} ${field}`,
        ).toBe(true);
        expect(
          JSON.stringify(row).includes(URL_USERINFO_SECRET),
          `credential retained for ${sample.name} ${input.kind}`,
        ).toBe(false);
      }
    }
  });

  it("preserves useful credential-free URL authorities and paths across free-text projections", () => {
    for (const sample of BENIGN_URL_CASES) {
      expect(hasParsedUserinfo(sample.value), `no userinfo for ${sample.name}`).toBe(false);
      const inputs: { input: TimelineProjectionInput; field: string }[] = [
        { input: { kind: "run_started", trigger: sample.value, steps: 1 }, field: "trigger" },
        {
          input: daemon({ type: "turn_failed", provider: "claude", error: sample.value }),
          field: "error",
        },
        {
          input: daemon({ type: "turn_canceled", provider: "claude", reason: sample.value }),
          field: "reason",
        },
        { input: { ...STEP_END, failure: sample.value }, field: "failure" },
        { input: { ...RUN_END, failure: sample.value }, field: "failure" },
      ];
      for (const { input, field } of inputs) {
        const value = projectTimelineEvent(input, scrub)?.data[field];
        expect(
          typeof value === "string" && value.includes(sample.useful),
          `useful URL for ${sample.name} ${input.kind} ${field}`,
        ).toBe(true);
      }
    }
  });

  it.each(
    USERINFO_SCHEMES.flatMap((scheme) =>
      ["/path@ordinary", "?item=@ordinary", "#path@ordinary"].map((suffix) => ({
        name: `${scheme} ${suffix[0]} boundary`,
        authority: `${scheme}://host`,
        value: `${scheme}://host${suffix}`,
      })),
    ),
  )("keeps the non-userinfo authority visible after the $name", ({ value, authority }) => {
    const row = projectTimelineEvent({ ...RUN_END, failure: value }, scrub);
    expect(row?.data["failure"]).toContain(authority);
  });

  it("treats ambiguous authority whitespace conservatively without requiring a parseable URL", () => {
    const value = "postgres://host ordinary prose @reader";
    expect(projectTimelineEvent({ ...RUN_END, failure: value }, scrub)?.data["failure"]).toBe(
      "[redacted]",
    );
  });

  it("uses tool names only when the scrubbed name pattern permits them and never includes an unnamed permission tool", () => {
    for (const name of ["bad=name", "Read\n", "\ud800", "", ["gh", "p_short"].join("")]) {
      expect(
        projectTimelineEvent(
          daemon({
            type: "timeline",
            provider: "claude",
            item: { type: "tool_call", name, callId: "id", status: "running" },
          }),
          scrub,
        )?.data["tool"],
      ).toBe("unnamed");
      expect(
        projectTimelineEvent(
          daemon({ type: "permission_requested", provider: "claude", request: { toolName: name } }),
          scrub,
        )?.data,
      ).toEqual({});
    }
    expect(
      projectTimelineEvent(
        daemon({ type: "permission_requested", provider: "claude", request: {} }),
        scrub,
      )?.data,
    ).toEqual({});
  });

  it("bounds free text in UTF-8 bytes and keeps quote-heavy and multibyte projected rows under 1024 bytes", () => {
    for (const value of ["\ud83d\ude00".repeat(240), '"'.repeat(240), "\u4e2d".repeat(240)]) {
      const rows = [
        projectTimelineEvent(
          daemon({ type: "turn_failed", provider: "claude", error: value }),
          scrub,
        ),
        projectTimelineEvent(
          daemon({ type: "turn_canceled", provider: "claude", reason: value }),
          scrub,
        ),
        projectTimelineEvent({ ...STEP_END, failure: value }, scrub),
        projectTimelineEvent({ ...RUN_END, failure: value }, scrub),
        projectTimelineEvent({ kind: "run_started", trigger: value, steps: 1 }, scrub),
      ];
      for (const row of rows) {
        expect(Buffer.byteLength(JSON.stringify(row?.data), "utf8")).toBeLessThanOrEqual(1024);
        for (const [field, bound] of [
          ["error", 240],
          ["reason", 120],
          ["failure", 120],
          ["trigger", 120],
        ] as const) {
          const text = row?.data[field];
          if (typeof text === "string")
            expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(bound);
        }
      }
    }
    const long = "a".repeat(100);
    const row = projectTimelineEvent(
      { kind: "step_started", type: "agent", agent: { provider: long, mode: long } },
      scrub,
    );
    expect(row?.data["agent"]).toEqual({
      provider: "a".repeat(61) + "...",
      mode: "a".repeat(61) + "...",
    });
  });

  it("validates finite nonnegative durations, integer counts, status enums, completion and script exit codes", () => {
    for (const value of [-1, NaN, Infinity, -Infinity]) {
      expect(projectTimelineEvent({ ...STEP_END, durationMs: value }, scrub)).toBeUndefined();
      expect(projectTimelineEvent({ ...RUN_END, durationMs: value }, scrub)).toBeUndefined();
    }
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        projectTimelineEvent({ kind: "run_started", trigger: "build", steps: value }, scrub),
      ).toBeUndefined();
      expect(projectTimelineEvent({ ...RUN_END, stepRowsOmitted: value }, scrub)).toBeUndefined();
      expect(
        projectTimelineEvent({ ...RUN_END, steps: { ...STEPS, total: value } }, scrub),
      ).toBeUndefined();
    }
    for (const input of [
      changed(STEP_END, "status", "running"),
      changed(STEP_END, "status", { toString: () => "failed" }),
      changed(RUN_END, "status", "skipped"),
      changed(STEP_END, "completion", "arbitrary"),
      changed(STEP_END, "failure", 42),
      changed(RUN_END, "failure", 42),
    ]) {
      expect(projectTimelineEvent(input, scrub)).toBeUndefined();
    }
    for (const exitCode of [-1, 256, 1.5, NaN, Infinity])
      expect(projectTimelineEvent({ ...STEP_END, exitCode }, scrub)).toBeUndefined();
    for (const exitCode of [0, 255])
      expect(projectTimelineEvent({ ...STEP_END, exitCode }, scrub)?.data["exitCode"]).toBe(
        exitCode,
      );
    expect(projectTimelineEvent({ ...STEP_END, durationMs: 0.5 }, scrub)?.data["durationMs"]).toBe(
      0.5,
    );
    expect(
      projectTimelineEvent({ ...RUN_END, steps: { ...STEPS, total: 6 } }, scrub),
    ).toBeUndefined();
    expect(projectTimelineEvent({ ...RUN_END, stepRowsOmitted: 5 }, scrub)).toBeUndefined();
  });

  it("preserves explicit null script exit codes, omits null failure and script agent metadata, without mutating inputs", () => {
    const input = Object.freeze({ ...STEP_END, failure: null, exitCode: null });
    expect(projectTimelineEvent(input, scrub)).toEqual({
      kind: "step_finished",
      data: { status: "failed", durationMs: 250, exitCode: null },
    });
    expect(projectTimelineEvent(STEP_END, scrub)).toEqual({
      kind: "step_finished",
      data: { status: "failed", durationMs: 250 },
    });
    expect(
      projectTimelineEvent(
        { kind: "step_started", type: "script", agent: { provider: "not-stored" } },
        scrub,
      ),
    ).toEqual({ kind: "step_started", data: { type: "script" } });
    expect(projectTimelineEvent({ kind: "step_started", type: "agent" }, scrub)).toEqual({
      kind: "step_started",
      data: { type: "agent" },
    });
  });
});
