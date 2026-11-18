import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { createStreamHarness, StreamReader, streamRequest } from "./test-utils.js";

it("stops a 50-event replay when payload expiry begins mid-stream", async () => {
  const harness = await createStreamHarness("memory");
  const stream = harness.stream();
  let reader: StreamReader | undefined;
  try {
    const run = await harness.createRun();
    for (let event = 0; event < 50; event++) await harness.append(run.id);
    const readRun = harness.database.findTriggerRunForOrganization.bind(harness.database);
    let marker: Date | null = null;
    vi.spyOn(harness.database, "findTriggerRunForOrganization").mockImplementation(
      async (organizationId, runId) => {
        const current = await readRun(organizationId, runId);
        return current === undefined ? undefined : { ...current, payloadExpiredAt: marker };
      },
    );
    const pages = vi.spyOn(harness.database, "listRunTimelineEvents");
    reader = new StreamReader(await stream.handle(streamRequest(run.id, harness.key), run.id));
    for (let seq = 1; seq <= 40; seq++) {
      const { data } = await reader.event("turn_started");
      assert.equal(data["seq"], seq);
    }
    assert.equal(pages.mock.calls.filter(([, , page]) => page.limit === 100).length, 1);
    marker = new Date();
    const next = await reader.frame();
    assert.equal(next, 'event: error\ndata: {"code":"timeline_expired"}');
    assert.equal(await reader.frame(), undefined);
    assert.doesNotMatch(reader.text, /id: 4[1-9]\n|id: 50\n/u);
    assert.equal(stream.activeStreamCount(), 0);
  } finally {
    await reader?.cancel();
    await stream.beginShutdown();
    await harness.close();
  }
});
