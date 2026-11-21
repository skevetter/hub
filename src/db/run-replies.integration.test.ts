import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { LinearRunReplyWriter } from "../run-replies/linear.js";
import { fakeLinearReplies, replyEvidence } from "../run-replies/test-utils/linear.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";

describe.each(["memory", "postgres"])("run reply admissions (%s)", (driver) => {
  let harness: TimelinePostgresHarness | undefined;
  let memory: ReturnType<typeof createMemoryDatabase>;
  beforeEach(async () => {
    memory = createMemoryDatabase();
    if (driver === "postgres") harness = await createTimelinePostgresHarness();
  }, 120_000);
  afterEach(async () => {
    await harness?.close();
  }, 120_000);

  async function createRun(replyMessage = true) {
    if (harness)
      return harness.createRun({ ...replyEvidence, ...(replyMessage ? { replyMessage } : {}) });
    return (
      await memory.createAcceptedTriggerRun({
        organizationId: TIMELINE_ORGANIZATION,
        projectId: "project",
        configurationRevisionId: "revision",
        providerEventReceiptId: randomUUID(),
        configuredTriggerName: "reply",
        prompt: "",
        inputs: {},
        ...replyEvidence,
        deadlineAt: new Date(Date.now() + 5_000),
        stepIds: ["work"],
        ...(replyMessage ? { replyMessage } : {}),
      })
    ).run;
  }

  it("reserves one comment across independent clients and retains only delivery metadata", async () => {
    const database = harness?.database ?? memory;
    const peer = (await harness?.connect())?.database ?? memory;
    const run = await createRun();
    const key = { organizationId: run.organizationId, runId: run.id };
    const input = {
      ...key,
      length: 42,
      hash: "a".repeat(64),
      bindingHash: "b".repeat(64),
      perHour: 60,
    };
    assert.ok(database.runReplies, "the opted-in run should have a durable reply store");
    const off = await createRun(false);
    assert.equal(await database.runReplies.find({ ...key, runId: off.id }), undefined);
    const pending = await database.runReplies.find(key);
    assert.equal(pending?.state, "pending");
    assert.equal(await database.runReplies.reserve(input), "run_unavailable");
    await database.succeedTriggerRun(run.id);
    const attempts = await Promise.all([
      database.runReplies.reserve(input),
      peer.runReplies.reserve(input),
    ]);
    assert.deepEqual(attempts.toSorted(), ["already_handled", "reserved"]);

    const freshClient = (await harness?.connect())?.database ?? memory;
    const reserved = await freshClient.runReplies.find(key);
    assert.equal(reserved?.state, "sending");
    assert.equal(reserved?.commentId, pending?.commentId);
    assert.equal(reserved?.length, 42);
    assert.equal(reserved?.hash, input.hash);
    const recoverable = await freshClient.runReplies.recoverable(new Date(Date.now() + 1_000));
    assert.ok(recoverable.some(({ runId }) => runId === run.id));
    assert.equal(
      await freshClient.runReplies.finish({ ...key, from: "sending", failure: null }),
      true,
    );
    assert.equal(await database.runReplies.reserve(input), "already_handled");
    assert.equal((await database.runReplies.find(key))?.state, "sent");
  });

  it("does not reserve for failed or canceled runs and charges concurrent sends against the cap", async () => {
    const database = harness?.database ?? memory;
    const peer = (await harness?.connect())?.database ?? memory;
    const failed = await createRun();
    const canceled = await createRun();
    const successful = [await createRun(), await createRun()];
    await database.failWorkflowRun(failed.id, "failed", "test");
    await database.cancelTriggerRun(canceled.organizationId, canceled.id);
    const input = (run: typeof failed, perHour: number) => ({
      organizationId: run.organizationId,
      runId: run.id,
      length: 1,
      hash: "a".repeat(64),
      bindingHash: "b".repeat(64),
      perHour,
    });
    assert.ok(database.runReplies);
    assert.equal(await database.runReplies.reserve(input(failed, 60)), "run_unavailable");
    assert.equal(await database.runReplies.reserve(input(canceled, 60)), "run_unavailable");
    await Promise.all(successful.map(({ id }) => database.succeedTriggerRun(id)));
    const attempts = await Promise.all([
      database.runReplies.reserve(input(successful[0]!, 1)),
      peer.runReplies.reserve(input(successful[1]!, 1)),
    ]);
    assert.deepEqual(attempts.toSorted(), ["rate_limited", "reserved"]);
    assert.equal(
      (await database.runReplies.find(input(successful[attempts.indexOf("rate_limited")]!, 1)))
        ?.failure,
      "rate_limited",
    );
  });

  it.each([true, false])(
    "repairs without another create after a lost response (marker retained: %s)",
    async (retainMarker) => {
      const database = harness?.database ?? memory;
      const run = await createRun();
      const fake = fakeLinearReplies(run.organizationId, database);
      fake.loseCreateResponse();
      const options = {
        client: fake.client,
        connectionForLinearOrganization: fake.connectionForLinearOrganization,
        clientSecret: "fake-client-secret",
        providerApplicationId: "app",
      };
      const terminal = await database.succeedTriggerRun(run.id);
      assert.equal(terminal?.run.outcome, "accepted");
      if (terminal?.run.outcome !== "accepted") throw new Error("expected accepted run");
      const key = { organizationId: run.organizationId, runId: run.id };
      const answer = { text: "Example final answer.", truncated: false };
      const signal = new AbortController().signal;
      await new LinearRunReplyWriter({ ...options, database }).post(
        terminal.run,
        answer,
        60,
        signal,
      );

      const restarted = (await harness?.connect())?.database ?? memory;
      const record = await restarted.runReplies.find(key);
      assert.equal(record?.state, "sending");
      assert.doesNotMatch(JSON.stringify(record), /Example final answer/u);
      if (!retainMarker)
        fake.comments.get(record.commentId)!.body = "A comment without the marker.";
      const recoveredWriter = new LinearRunReplyWriter({ ...options, database: restarted });
      await recoveredWriter.repair(terminal.run, record, signal);
      await recoveredWriter.post(terminal.run, answer, 60, signal);
      assert.equal(fake.calls.filter((call) => call === "create").length, 1);
      const result = await restarted.runReplies.find(key);
      assert.equal(result?.state, retainMarker ? "sent" : "refused");
      assert.equal(result?.failure, retainMarker ? null : "delivery_unconfirmed");
    },
  );
});
