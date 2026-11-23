import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, it, onTestFinished, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import * as replyFormat from "./format.js";
import { LinearRunReplyWriter } from "./linear.js";
import { yieldToEventLoop } from "./test-utils/event-loop.js";
import { fakeLinearReplies, replyEvidence } from "./test-utils/linear.js";

const signal = new AbortController().signal;

function pinFormatterClock(): void {
  const { formatRunReply } = replyFormat;
  const formatter = vi
    .spyOn(replyFormat, "formatRunReply")
    .mockImplementation((answer, secrets, options) =>
      formatRunReply(answer, secrets, { ...options, now: () => 0 }),
    );
  onTestFinished(() => formatter.mockRestore());
}

function assertNoMentionNodes(tree: Root, index: number): void {
  const nodes = [...tree.children];
  for (const node of nodes) {
    if ("children" in node) nodes.push(...node.children);
    if ("value" in node) {
      assert.doesNotMatch(
        node.value,
        /[@\uFF20]|linear\.app\/acme\/profiles(?:\/|$)/iu,
        `case ${index}`,
      );
    }
    if (node.type === "link") {
      assert.doesNotMatch(
        node.url,
        /^https?:\/\/linear\.app\/acme\/profiles(?:\/|$)/iu,
        `case ${index}`,
      );
    }
  }
}

async function fixture(options: { differentTarget?: boolean; canceled?: boolean } = {}) {
  const database = createMemoryDatabase();
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: "org",
    projectId: "project",
    configurationRevisionId: "revision",
    providerEventReceiptId: randomUUID(),
    configuredTriggerName: "answer",
    prompt: "",
    inputs: {},
    ...replyEvidence,
    ...(options.differentTarget
      ? { outputContext: { ...replyEvidence.outputContext, issueId: "elsewhere" } }
      : {}),
    deadlineAt: new Date(Date.now() + 5_000),
    stepIds: ["work"],
    replyMessage: true,
  });
  const fake = fakeLinearReplies(run.organizationId, database);
  const writer = new LinearRunReplyWriter({
    database,
    client: fake.client,
    connectionForLinearOrganization: fake.connectionForLinearOrganization,
    clientSecret: "fake-client-secret",
    providerApplicationId: "app",
  });
  const terminal = options.canceled
    ? await database.cancelTriggerRun(run.organizationId, run.id)
    : await database.succeedTriggerRun(run.id);
  assert.equal(terminal?.run.outcome, "accepted");
  if (terminal?.run.outcome !== "accepted") throw new Error("run must be accepted");
  const finishedRun = terminal.run;
  const key = { organizationId: run.organizationId, runId: run.id };
  return {
    ...fake,
    send: (text: string, abort = signal) =>
      writer.post(finishedRun, { text, truncated: false }, 60, abort),
    delivery: () => database.runReplies.find(key),
    async repair() {
      const delivery = await database.runReplies.find(key);
      assert.equal(delivery?.state, "sending");
      await writer.repair(finishedRun, delivery, signal);
    },
  };
}

describe("Linear reply writer", () => {
  it("posts a reply whose answer ends with a deep container chain", async () => {
    const test = await fixture();
    await test.send(`The deploy is fixed.\n\n${"- >".repeat(400)} q`);
    assert.equal((await test.delivery())?.failure ?? null, null);
    assert.equal(test.writes.length, 1);
  });

  const profileUrl = "https://linear.app/acme/profiles/bob";

  it("does not turn a clipped link destination into a Linear profile link", async () => {
    const { send, writes, delivery } = await fixture();
    await send(
      `${"a".repeat(3_400)} [x](<https://example.com/a b ${profileUrl} ${"z".repeat(200)}>)`,
    );
    assert.equal((await delivery())?.state, "sent");
    assert.ok(!writes[0]?.includes(profileUrl), "a profile URL survived the cut");
  });

  it("removes a user tag cut off before its closing bracket", async () => {
    const { send, writes } = await fixture();
    await send(`${"a".repeat(3_423)} <user id="${"z".repeat(300)}">`);
    assert.match(writes[0] ?? "", /\[Reply truncated\]/u);
    assert.doesNotMatch(writes[0]!, /<user\b/iu);
  });

  it("still posts a safe prefix when escaping several raw cuts exceeds the size limit", async () => {
    const { send, delivery, writes } = await fixture();
    const text = [
      "Answer.",
      "![alt][carol] *@alice.smith*".repeat(70),
      '[t][@\u202eeveryone] \uFF20alice.smith <user id="team-x">'.repeat(40),
    ].join("\r\n\r\n");
    await send(text);
    const result = await delivery();
    assert.ok(result?.state === "sent" && result.length && result.length <= 3_500);
    assert.match(writes[0]!, /^Answer\\?\./u);
    assert.doesNotMatch(writes[0]!, /[@\uFF20]|<user\b/iu);
  });

  it("keeps bare email addresses visible with the mention sign neutralized", async () => {
    const { send, writes } = await fixture();
    await send("Email ops@example.com if the deploy fails.");
    assert.match(writes[0] ?? "", /Email ops\\?\[at\]example\.com if the deploy fails\./u);
  });

  it("keeps part of a long opening code fence and posts metadata outside it", async () => {
    const { send, writes } = await fixture();
    await send(`\`\`\`log\n${"One line from the log.\n".repeat(300)}\`\`\``);
    const markdown = fromMarkdown(writes[0] ?? "");
    const code = markdown.children[0];
    assert.equal(code?.type, "code");
    assert.match(code.value, /One line from the log\./u);
    assert.deepEqual(
      markdown.children.slice(1).map(({ type }) => type),
      ["paragraph", "paragraph"],
    );
  });

  it("posts safe Markdown across 2,048 generated documents cut around Markdown constructs", async () => {
    const user = "&#64;bob";
    const atoms = [
      `[x](<https://example.com/a b ${profileUrl} ${"z".repeat(200)}>)`,
      `[${user}](${profileUrl})`,
      `[link](https://example.com "${profileUrl} ${user}")`,
      `[name][${user}]\n\n[${user}]: ${profileUrl}`,
      `[${user}][]\n\n[${user}]: https://example.com`,
      `[side note][^${user}]\n\n[^${user}]: ${profileUrl}`,
      `![@bob](${profileUrl})`,
      `<${profileUrl}>`,
      `<!-- ${profileUrl} ${user} -->`,
      `&lt;user id=bob&gt; @bob ${profileUrl}`,
      `\`\`\`ts ${user}\n${profileUrl}\n\`\`\``,
      `\`${profileUrl} ${user}\``,
      `| Name | URL |\n| --- | --- |\n| ${user} | ${profileUrl} |`,
      `> **${user}** ~~${profileUrl}~~`,
      `- ${user}\n  - ${profileUrl}`,
      `# ${user} ${profileUrl}`,
    ];
    const extensions = [gfm()];
    const mdastExtensions = [gfmFromMarkdown()];
    for (let index = 0; index < 2_048; index += 1) {
      if (index % 16 === 0) await yieldToEventLoop();
      const atom = atoms[index % atoms.length]!;
      const pad = 3_290 + ((index * 1_831) % 221);
      const separator = index % 3 === 0 ? " " : "\n\n";
      const { send, writes, delivery } = await fixture();
      await send(`${"a".repeat(pad)}${separator}${atom}\n\n${"tail ".repeat(80)}`);
      const result = await delivery();
      assert.ok(
        result?.state === "sent" && result.length && result.length <= 3_500,
        `case ${index}`,
      );
      const body = writes[0]!;
      assert.doesNotMatch(
        body,
        /[@\uFF20]|linear\.app\.?\/acme\/profiles(?:\/|$)/iu,
        `raw mention or profile URL in case ${index}`,
      );
      const tree = fromMarkdown(body, { extensions, mdastExtensions });
      assertNoMentionNodes(tree, index);
      assert.equal(tree.children.at(-1)?.type, "paragraph", `marker in case ${index}`);
      assert.equal(tree.children.at(-2)?.type, "paragraph", `notice in case ${index}`);
    }
  }, 120_000);

  it.each([
    "https://linear.app./acme/profiles/bob",
    "herehttps://linear.app./acme/profiles/bob",
    "herehttps://linear.app/acme/profiles/bob",
    "see linea<b></b>r&period;app/acme/profiles/bob",
    "see linea<b></b>r.app/acme/profiles/bob",
    "say &#6<i></i>4;bob",
  ])("neutralizes mentions in the serialized body for %s", async (text) => {
    const { send, writes } = await fixture();
    await send(`Answer. ${text}`);
    const body = writes[0] ?? "";
    const paragraph = fromMarkdown(body).children[0];
    assert.equal(paragraph?.type, "paragraph");
    assert.equal(paragraph.children.length, 1);
    const visible = paragraph.children[0];
    assert.equal(visible?.type, "text");
    assert.match(visible.value, /^Answer\./u);
    const forbidden = /linear\.app\.?\/acme\/profiles\/bob|[@\uFF20]|&#64;/iu;
    assert.doesNotMatch(body, forbidden);
    assert.doesNotMatch(visible.value, forbidden);
  });

  it("records an unexpected sanitizer exception as an unrenderable reply", async () => {
    const format = vi.spyOn(replyFormat, "formatRunReply").mockImplementationOnce(() => {
      throw new RangeError("simulated Markdown stack overflow");
    });
    try {
      const { send, calls, delivery } = await fixture();
      await send("Answer.");
      assert.deepEqual(calls, []);
      const result = await delivery();
      assert.equal(result?.state, "refused");
      assert.equal(result.failure, "reply_unrenderable");
    } finally {
      format.mockRestore();
    }
  });
  it("posts one marked, sanitized and truncated answer with only comments:create", async () => {
    pinFormatterClock();
    const { send, writes, delivery } = await fixture();
    const text = `Hello @teammate, &#64;paseo and https://linear.app/team/profiles/alex.

[ordinary link](https://example.com/docs) ![image](https://example.com/pic.png) <img src="https://example.com/pic.png">

Thanks [team][@bob], [@bob][], and [normal][docs].

[@bob]: https://example.com "@title https://linear.app/team/profiles/title"
[docs]: https://example.com/reference "Ordinary title"
[@everyone]: https://example.com

A footnote[^@bob] and an [inline title](https://example.com "@inline").

[^@bob]: Footnote @author and https://linear.app/team/profiles/footnote.

![alt @image](https://example.com/image) ![alt @reference][docs]

<https://linear.app/team/profiles/autolink> <name@example.com>

&lt;user id="encoded-id"&gt; <!-- @comment <user id="html-id"> -->

\`\`\`@language https://linear.app/team/profiles/meta
Code @example
\`\`\`

fake-client-secret

${"line from the answer\n".repeat(250)}`;
    await Promise.all([send(text), send(text)]);
    assert.equal(writes.length, 1);
    const body = writes[0]!;
    const result = await delivery();
    assert.equal(result?.state, "sent");
    assert.ok(result?.length && result.length <= 3_500);
    assert.match(result.hash ?? "", /^[a-f0-9]{64}$/u);
    assert.ok(body.includes(result.commentId));
    assert.match(body, /line from the answer\n\n\[Reply truncated\]/u);
    assert.match(body, /\[ordinary link\]\(https:\/\/example.com\/docs\)/u);
    const reference = /\[normal\]\[([^\]]+)\]/u.exec(body);
    assert.ok(reference?.[1]);
    assert.ok(body.includes(`[${reference[1]}]: https://example.com/reference "Ordinary title"`));
    assert.match(body, /Footnote/u);
    assert.doesNotMatch(
      body,
      /@|\/profiles\/|pic\.png|<img|encoded-id|html-id|fake-client-secret/u,
    );
  });

  const markdownShapes = [
    (mention: string) => `Prose **${mention}** and \`${mention}\`.`,
    (mention: string) => `[teammate][${mention}]\n\n[${mention}]: https://example.com`,
    (mention: string) => `[${mention}][]\n\n[${mention}]: https://example.com`,
    (mention: string) => `Text[^${mention}]\n\n[^${mention}]: ${mention}`,
    (mention: string) =>
      `[link](https://example.com "${mention}") ![${mention}](https://example.com/image)`,
    (mention: string) => `<!-- ${mention} -->\n\n<${mention}>`,
    (mention: string) => `\`\`\`${mention}\n${mention}\n\`\`\``,
    (mention: string) => `| Header |\n| ------ |\n| ${mention} |`,
  ];

  it("neutralizes generated mention forms across Markdown shapes in the posted body", async () => {
    pinFormatterClock();
    for (let index = 0; index < markdownShapes.length; index += 1) {
      const shape = markdownShapes[index]!;
      const samples = [
        `@user-${index}`,
        `\uFF20user-${index}`,
        `&#x40;user-${index}`,
        `https://linear.app/team/profiles/user-${index}`,
        `https://linear.app/team/%75sers/user-${index}`,
        `https://linear.app/team/agents/user-${index}`,
      ];
      const { send, writes } = await fixture();
      await send(["Safe answer.", ...samples.map(shape)].join("\n\n"));
      assert.equal(writes.length, 1, `Markdown shape ${index}`);
      assert.match(writes[0]!, /Safe answer\./u);
      assert.doesNotMatch(
        writes[0]!,
        /[@\uFF20]|&#(?:0*64|x0*40);|linear\.app\/[^\s]*\/(?:profiles|users|%75sers|agents)\//iu,
        `Markdown shape ${index}`,
      );
    }
  });

  it.each([
    {
      structure: "code fence",
      text: `Answer.\n\n\`\`\`ts\n${"const answer = 1;\n".repeat(280)}\`\`\``,
    },
    {
      structure: "table row",
      text: `Answer.\n\n| Key | Value |\n| --- | --- |\n${"| item | complete |\n".repeat(230)}`,
    },
    {
      structure: "inline code",
      text: `Answer. \`${"long command ".repeat(340)}\``,
    },
  ])(
    "keeps delivery metadata outside a truncated $structure and repairs the delivery",
    async ({ structure, text }) => {
      pinFormatterClock();
      const reply = await fixture();
      const { send, writes, delivery } = reply;
      reply.loseCreateResponse();
      await send(text);
      assert.equal(writes.length, 1);
      const result = await delivery();
      assert.ok(result?.length && result.length <= 3_500);
      const body = writes[0]!;
      const markdown = fromMarkdown(body, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      });
      for (const [index, label] of [
        "[Reply truncated]",
        `Paseo reply ${result.commentId}`,
      ].entries()) {
        const paragraph = markdown.children.at(index - 2);
        assert.equal(paragraph?.type, "paragraph");
        assert.deepEqual(
          paragraph.children.map((node) => (node.type === "text" ? node.value : null)),
          [label],
        );
      }
      if (structure === "inline code") assert.match(body, /^Answer\.\n\n/u);
      if (structure === "table row") {
        const table = markdown.children.find((node) => node.type === "table");
        assert.ok(table && table.children.length > 1);
        for (const row of table.children.slice(1)) {
          const value = row.children[1]?.children[0];
          assert.ok(value?.type === "text" && value.value === "complete");
        }
      }
      await reply.repair();
      assert.equal((await delivery())?.state, "sent");
      assert.equal(writes.length, 1);
    },
  );

  it("records an empty sanitized answer without making a request", async () => {
    pinFormatterClock();
    const { send, calls, delivery } = await fixture();
    await send("![image](https://example.com/pic.png)");
    assert.deepEqual(calls, []);
    assert.equal((await delivery())?.failure, "empty_answer");
  });

  it.each([200, 400])(
    "records HTTP %i GraphQL request validation as a rejection",
    async (status) => {
      const { send, writes, delivery, createResponses } = await fixture();
      createResponses.push(
        Response.json(
          {
            errors: [
              { message: "Invalid input", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } },
            ],
          },
          { status },
        ),
      );
      await send("Answer.");
      assert.equal(writes.length, 0);
      const result = await delivery();
      assert.equal(result?.state, "refused");
      assert.equal(result.failure, "provider_rejected");
    },
  );

  const rateLimit = { message: "Try again later", extensions: { code: "RATELIMITED" } };

  it("uses Retry-After before retrying a rejected create with the same reserved UUID", async () => {
    vi.useFakeTimers();
    try {
      const { send, creates, writes, delivery, createResponses } = await fixture();
      createResponses.push(
        Response.json({ errors: [rateLimit] }, { status: 429, headers: { "retry-after": "2" } }),
      );
      const posting = send("Answer.");
      await vi.advanceTimersByTimeAsync(1_999);
      assert.equal(creates.length, 1);
      assert.equal(writes.length, 0);
      await vi.advanceTimersByTimeAsync(1);
      await posting;
      assert.equal(creates.length, 2);
      assert.deepEqual(creates[0], creates[1]);
      assert.equal(writes.length, 1);
      const result = await delivery();
      assert.equal(result?.state, "sent");
      assert.equal(result.commentId, creates[0]?.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["retry rejected", "retry canceled"])(
    "records a rate limit when the %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const { send, creates, writes, delivery, createResponses } = await fixture();
        const response = () => Response.json({ errors: [rateLimit] }, { status: 429 });
        createResponses.push(response(), response());
        const abort = new AbortController();
        const posting = send("Answer.", abort.signal);
        await vi.advanceTimersByTimeAsync(29_999);
        assert.equal(creates.length, 1);
        if (outcome === "retry canceled") abort.abort();
        await vi.advanceTimersByTimeAsync(1);
        await posting;
        assert.equal(creates.length, outcome === "retry canceled" ? 1 : 2);
        assert.equal(writes.length, 0);
        const result = await delivery();
        assert.equal(result?.state, "refused");
        assert.equal(result.failure, "provider_rate_limited");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("records a structured HTTP 429 rejecting the commentCreate field as a refusal", async () => {
    const { send, creates, delivery, createResponses } = await fixture();
    createResponses.push(
      Response.json(
        {
          data: null,
          errors: [{ ...rateLimit, path: ["commentCreate"] }],
        },
        { status: 429 },
      ),
    );
    await send("Answer.");
    assert.equal(creates.length, 1);
    const result = await delivery();
    assert.equal(result?.state, "refused");
    assert.equal(result.failure, "provider_rate_limited");
  });

  it("records Linear's invalid input error on commentCreate as a refusal", async () => {
    const { send, creates, delivery, createResponses } = await fixture();
    createResponses.push(
      Response.json({
        data: null,
        errors: [
          {
            message: "Invalid comment input",
            path: ["commentCreate"],
            extensions: { type: "invalid input" },
          },
        ],
      }),
    );
    await send("Answer.");
    assert.equal(creates.length, 1);
    const result = await delivery();
    assert.equal(result?.state, "refused");
    assert.equal(result.failure, "provider_rejected");
  });

  it("leaves HTTP 429 after a possibly successful create for repair without a second create", async () => {
    const reply = await fixture();
    reply.createResponses.push(
      Response.json(
        {
          data: null,
          errors: [{ ...rateLimit, path: ["commentCreate", "comment"] }],
        },
        { status: 429 },
      ),
    );
    await reply.send("Answer.");
    assert.equal((await reply.delivery())?.state, "sending");
    await reply.repair();
    assert.equal(reply.creates.length, 1);
    assert.equal((await reply.delivery())?.failure, "delivery_unconfirmed");
  });

  it("refuses a canceled run and inconsistent destination before provider access", async () => {
    const canceled = await fixture({ canceled: true });
    await canceled.send("Do not post this.");
    assert.deepEqual(canceled.calls, []);
    assert.equal((await canceled.delivery())?.failure, "run_unsuccessful");
    const mismatch = await fixture({ differentTarget: true });
    await mismatch.send("Do not post this.");
    assert.deepEqual(mismatch.calls, []);
    assert.equal((await mismatch.delivery())?.failure, "target_mismatch");
  });

  it("refuses a source comment that moved or was edited", async () => {
    const moved = await fixture();
    moved.comments.get("source-comment")!.issue.id = "other-issue";
    await moved.send("Do not post this.");
    assert.deepEqual(moved.calls, ["read-comment"]);
    assert.equal((await moved.delivery())?.failure, "target_mismatch");

    const edited = await fixture();
    edited.comments.get("source-comment")!.body = "Different request";
    await edited.send("Do not post this.");
    assert.deepEqual(edited.calls, ["read-comment"]);
    assert.equal((await edited.delivery())?.failure, "target_mismatch");
  });

  it("refuses an installation belonging to another Hub organization", async () => {
    const { send, calls, delivery, connection } = await fixture();
    connection.organizationId = "other-org";
    await send("Do not post this.");
    assert.deepEqual(calls, []);
    assert.equal((await delivery())?.failure, "connection_unavailable");
  });
});
