import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { LinearRunReplyWriter } from "./linear.js";
import { fakeLinearReplies, replyEvidence } from "./test-utils/linear.js";

const signal = new AbortController().signal;

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
    send: (text: string) => writer.post(finishedRun, { text, truncated: false }, 60, signal),
    delivery: () => database.runReplies.find(key),
    async repair() {
      const delivery = await database.runReplies.find(key);
      assert.equal(delivery?.state, "sending");
      await writer.repair(finishedRun, delivery, signal);
    },
  };
}

describe("Linear reply writer", () => {
  it("posts one marked, sanitized and truncated answer with only comments:create", async () => {
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
    const { send, calls, delivery } = await fixture();
    await send("![image](https://example.com/pic.png)");
    assert.deepEqual(calls, []);
    assert.equal((await delivery())?.failure, "empty_answer");
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
