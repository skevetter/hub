import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  };
}

describe("Linear reply writer", () => {
  it("posts one marked, sanitized and truncated answer with only comments:create", async () => {
    const { send, writes, delivery } = await fixture();
    const text = `Hello @teammate, &#64;paseo and https://linear.app/team/profiles/alex.

[ordinary link](https://example.com/docs) ![image](https://example.com/pic.png) <img src="https://example.com/pic.png">

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
    assert.doesNotMatch(body, /@|profiles\/alex|pic\.png|<img|fake-client-secret/u);
  });

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
