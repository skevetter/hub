import { expect, test } from "vitest";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { LiveSessionTranscript, SessionTranscriptNormalizer } from "./normalize.js";

const at = "2026-11-20T12:00:00.000Z";
const secret = "exampleSensitiveValue";
const scrub = createTimelineScrubber({ scrubValues: [secret] });
const normalizer = new SessionTranscriptNormalizer([secret], scrub);
const commandId = "12345678-1234-1234-1234-123456789abc";

test("relays only scrubbed assistant text, tool summaries, and human anchors", () => {
  const normalize = (item: { type: string } & Record<string, unknown>) =>
    normalizer.stream({
      type: "agent_stream",
      agentId: "agent",
      seq: 9,
      epoch: "epoch",
      timestamp: at,
      event: { type: "timeline", provider: "codex", turnId: "turn", item },
    });
  expect(normalize({ type: "assistant_message", text: "Hello " + secret })).toEqual({
    kind: "assistant",
    seq: 9,
    turnId: "turn",
    text: "Hello [redacted]",
    truncated: false,
    at,
  });
  expect(
    normalize({
      type: "tool_call",
      name: "shell",
      status: "completed",
      input: secret,
      output: secret,
    }),
  ).toEqual({ kind: "tool", seq: 9, turnId: "turn", name: "shell", status: "completed", at });
  expect(normalize({ type: "tool_call", name: secret, status: "running" })?.kind).toBe("tool");
  expect(
    JSON.stringify(normalize({ type: "tool_call", name: secret, status: "running" })),
  ).not.toContain(secret);
  expect(normalize({ type: "reasoning", text: secret })).toBeUndefined();
  expect(normalize({ type: "user_message", text: secret, messageId: commandId })).toEqual({
    kind: "human",
    seq: 9,
    commandId,
    at,
  });
});

test("history uses the end sequence and bounds assistant output by UTF-8 bytes", () => {
  const item = normalizer.history({
    item: { type: "assistant_message", text: "\u00e9".repeat(40_000) },
    timestamp: at,
    seqStart: 3,
    seqEnd: 7,
    turnId: "turn",
  });
  expect(item).toMatchObject({ kind: "assistant", seq: 7, truncated: true, at, turnId: "turn" });
  if (item?.kind !== "assistant") throw new Error("Expected assistant item");
  expect(item.text.length).toBe(32_768);
  expect(item.text.replaceAll("\u00e9", "")).toBe("");
  expect(item.text).not.toContain("\ufffd");
});

test.each(["All tests passed", "keyboard", "author", "design doc"])(
  "keeps ordinary assistant prose: %s",
  (text) => {
    expect(
      normalizer.history({
        item: { type: "assistant_message", text },
        seqStart: 1,
        seqEnd: 1,
        timestamp: at,
      }),
    ).toMatchObject({ text, truncated: false });
  },
);

test("replaces credential spans and preserves surrounding prose", () => {
  const text =
    "Bearer abcdef12345678, ghp_Example123456, github_pat_Example123456, lin_api_Example123456; token=0123456789abcdef0123456789abcdef; eyJhbGciOiJIUzI1NiJ9.eyJmb28iOiJiYXIifQ.dGVzdHNpZ25hdHVyZQ";
  expect(
    normalizer.history({
      item: { type: "assistant_message", text },
      seqStart: 1,
      seqEnd: 1,
      timestamp: at,
    }),
  ).toMatchObject({
    text: "Bearer [redacted], [redacted], [redacted], [redacted]; token=[redacted]; [redacted]",
    truncated: false,
  });
});

test("the live transcript keeps up to 64 KiB of an assistant message and marks truncation", () => {
  const live = new LiveSessionTranscript(normalizer);
  const text = "All tests passed. " + "x".repeat(33_000);
  const entries = [1, 2].flatMap((seq) =>
    live.accept(timeline(seq, { type: "assistant_message", messageId: "reply", text })),
  );
  entries.push(...live.finish());
  const chunks = entries.flatMap((entry) =>
    "item" in entry && entry.item.kind === "assistant" ? [entry.item] : [],
  );
  expect(chunks.at(-1)).toMatchObject({ kind: "assistant", seq: 2, truncated: true });
  const received = chunks.map((item) => item.text).join("");
  expect(Buffer.byteLength(received)).toBe(65_536);
  expect(received.startsWith("All tests passed. ")).toBe(true);
});

const credentialShapes: [string, string, string?][] = [
  ["Anthropic", "sk-ant-api03-ExampleSomeValue123456"],
  ["OpenAI", "sk-proj-ExampleSomeValue123456"],
  ["AWS", "AKIAIOSFODNN7EXAMPLE"],
  ["AWS temporary", "ASIAIOSFODNN7EXAMPLE"],
  ["Slack bot", "xoxb-ExampleSomeValue123456"],
  ["Slack app", "xapp-ExampleSomeValue123456"],
  ["Paseo API", "paseo_pk_ExampleSomeValue123456"],
  ["Paseo CLI", "paseo_cli_ExampleSomeValue123456"],
  ["Stripe key", "sk_live_ExampleSomeValue123456"],
  ["Stripe restricted", "rk_live_ExampleSomeValue123456"],
  ["Stripe webhook", "whsec_ExampleSomeValue123456"],
  ["GitHub OAuth", "gho_ExampleSomeValue123456"],
  ["GitHub App", "ghs_ExampleSomeValue123456"],
  ["GitHub user", "ghu_ExampleSomeValue123456"],
  ["GitHub refresh", "ghr_ExampleSomeValue123456"],
  ["Google", "AIzaExampleSomeValue123456"],
  ["Linear OAuth", "lin_oauth_ExampleSomeValue123456"],
  ["High entropy", "Zq9vW3xT7pLm2Kd8Rf4YzN6Ju3Pb9Vz5"],
  [
    "PEM",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1wZW0tZGF0YQ==\n-----END OPENSSH PRIVATE KEY-----",
  ],
  [
    "database userinfo",
    "postgres://app:FixtureOnlyPassword27@db.internal/hub",
    "postgres://[redacted]db.internal/hub",
  ],
  [
    "URL query credentials",
    "https://hub.test/oauth?view=setup&code=fixture42&tab=1",
    "https://hub.test/oauth?view=setup&code=[redacted]&tab=1",
  ],
];

test.each(credentialShapes)(
  "scrubs %s spans in history and across live chunks",
  (_shape, value, replacement = "[redacted]") => {
    const text = "Before: " + value + " After.";
    const expected = "Before: " + replacement + " After.";
    const history = normalizer.history({
      item: { type: "assistant_message", text },
      timestamp: at,
      seqStart: 1,
      seqEnd: 1,
    });
    expect(history?.kind === "assistant" && history.text === expected).toBe(true);
    const live = new LiveSessionTranscript(normalizer);
    const items = (text.match(/[\s\S]{1,5}/gu) ?? []).flatMap((chunk, index) =>
      live.accept(
        timeline(index + 1, { type: "assistant_message", messageId: "reply", text: chunk }),
      ),
    );
    items.push(...live.finish());
    expect(
      items
        .map((entry) => ("item" in entry && entry.item.kind === "assistant" ? entry.item.text : ""))
        .join("") === expected,
    ).toBe(true);
  },
);

test("relays text progressively and emits both tool states before the turn completes", () => {
  const live = new LiveSessionTranscript(normalizer);
  const opening = "I'll run the tests. ";
  const paragraph = "The design doc explains the change. ".repeat(8);
  const rendered = [
    ...live.accept(
      timeline(1, { type: "assistant_message", messageId: "reply", text: opening + paragraph }),
    ),
    ...live.accept(timeline(2, { type: "assistant_message", messageId: "reply", text: paragraph })),
  ];
  expect(
    rendered.some(
      (entry) =>
        "item" in entry && entry.item.kind === "assistant" && entry.item.text.includes(opening),
    ),
  ).toBe(true);
  const running = live.accept(timeline(3, { type: "tool_call", name: "shell", status: "running" }));
  const complete = live.accept(
    timeline(4, { type: "tool_call", name: "shell", status: "completed" }),
  );
  expect(running.at(-1)).toMatchObject({ item: { kind: "tool", status: "running" } });
  expect(complete.at(-1)).toMatchObject({ item: { kind: "tool", status: "completed" } });
  expect(
    [...rendered, ...running, ...complete].map((entry) => ("item" in entry ? entry.item.seq : -1)),
  ).toEqual([1, 2, 3, 4]);
});

test("holds split credentials when another assistant message interleaves", () => {
  const live = new LiveSessionTranscript(new SessionTranscriptNormalizer(["fixture-secret"]));
  const items = [
    { messageId: "first", text: "See fixtu" },
    { messageId: "second", text: "Checking. " },
    { messageId: "first", text: "re-secret here." },
  ].flatMap((item, index) =>
    live.accept(timeline(index + 1, { type: "assistant_message", ...item })),
  );
  items.push(...live.finish());
  expect(
    items.flatMap((entry) =>
      "item" in entry && entry.item.kind === "assistant" ? [entry.item.text] : [],
    ),
  ).toEqual(["See ", "Checking. ", "[redacted] here."]);
});

function timeline(seq: number, item: { type: string } & Record<string, unknown>) {
  return {
    agentId: "agent",
    type: "agent_stream" as const,
    seq,
    epoch: "epoch",
    timestamp: at,
    event: { type: "timeline" as const, provider: "codex", item },
  };
}
