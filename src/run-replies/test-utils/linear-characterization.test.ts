import assert from "node:assert/strict";
import { it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { fakeLinearReplies } from "./linear.js";

it("records reserved creates and reads without writing rejected responses", async () => {
  const fake = fakeLinearReplies("org", createMemoryDatabase());
  const linearOrganizationId = "linear-org";
  const read = (commentId: string) =>
    fake.client.readComment(
      { linearOrganizationId, commentId },
      {
        binding: fake.connection,
        signal: new AbortController().signal,
        requiredScope: "comments:create",
      },
    );
  const create = (commentId: string) =>
    fake.client.createComment({ linearOrganizationId, issueId: "issue", body: "reply", commentId });
  assert.deepEqual(Object.keys(fake), [
    "client",
    "connection",
    "connectionForLinearOrganization",
    "comments",
    "calls",
    "writes",
    "creates",
    "createResponses",
    "loseCreateResponse",
  ]);
  assert.equal(await fake.connectionForLinearOrganization("other"), undefined);
  assert.notEqual(
    await fake.connectionForLinearOrganization(linearOrganizationId),
    fake.connection,
  );
  assert.equal((await read("source-comment"))?.body, "@paseo question");
  assert.equal(await read("missing"), null);
  assert.equal(await create("first"), "first");
  fake.createResponses.push(Response.json({ errors: [{ message: "denied" }] }, { status: 403 }));
  await assert.rejects(create("denied"));
  fake.loseCreateResponse();
  await assert.rejects(
    create("lost"),
    transportFailure("simulated response loss after Linear committed"),
  );
  assert.deepEqual(fake.calls, ["read-comment", "read-comment", "create", "create", "create"]);
  assert.deepEqual(
    fake.creates,
    ["first", "denied", "lost"].map((id) => ({ id, body: "reply" })),
  );
  assert.deepEqual(fake.writes, ["reply", "reply"]);
  assert.deepEqual([...fake.comments.keys()], ["source-comment", "first", "lost"]);
});

it("rejects unsupported operations and creates without a reserved ID before recording a call", async () => {
  const fake = fakeLinearReplies("org", createMemoryDatabase());
  await assert.rejects(
    fake.client.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue",
      body: "reply",
    }),
    transportFailure("reply mutation must use a reserved UUID"),
  );
  await assert.rejects(
    fake.client.updateComment({
      linearOrganizationId: "linear-org",
      commentId: "id",
      body: "reply",
    }),
    transportFailure("unexpected Linear operation"),
  );
  assert.deepEqual(fake.calls, []);
});

function transportFailure(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Linear request failed");
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, message);
    return true;
  };
}
