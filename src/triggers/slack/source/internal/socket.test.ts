import { expect, it, vi } from "vitest";
import { startSlackSocketFixture } from "../../../../test-utils/slack-socket-fixture.js";
import { createSlackSocketSource, type SlackSocketSourceOptions } from "./socket.js";

it("acknowledges malformed and rate-limited envelopes without durable intake", async () => {
  await withSocket(async ({ slack, accept }) => {
    slack.send({ envelope_id: "malformed" });
    slack.send({
      type: "events_api",
      envelope_id: "rate-limited",
      payload: { type: "app_rate_limited", team_id: "T1" },
    });
    await vi.waitFor(() =>
      expect(slack.acks).toEqual([{ envelope_id: "malformed" }, { envelope_id: "rate-limited" }]),
    );
    expect(accept).not.toHaveBeenCalled();
  });
});

it("requires explicit retry after Slack disables the link", async () => {
  await withSocket(async ({ slack, source }) => {
    slack.send({ type: "disconnect", reason: "link_disabled" });
    await vi.waitFor(() =>
      expect(source.status()).toEqual({ state: "actionNeeded", reason: "socketModeOff" }),
    );
    expect(slack.openCount).toBe(1);
    expect(slack.acks).toEqual([]);

    await source.retry();
    await vi.waitFor(() => expect(source.status()).toEqual({ state: "connected" }));
    expect(slack.openCount).toBe(2);
  });
});

interface SocketTestFixture {
  slack: Awaited<ReturnType<typeof startSlackSocketFixture>>;
  source: ReturnType<typeof createSlackSocketSource>;
  accept: SlackSocketSourceOptions["accept"];
}

async function withSocket(run: (fixture: SocketTestFixture) => Promise<void>): Promise<void> {
  const slack = await startSlackSocketFixture();
  const accept = vi.fn<SlackSocketSourceOptions["accept"]>();
  const source = createSlackSocketSource({
    appId: "A123",
    appToken: "test-token",
    apiUrl: slack.openUrl,
    accept,
  });
  try {
    await source.start(() => Promise.resolve());
    await vi.waitFor(() => expect(source.status()).toEqual({ state: "connected" }));
    await run({ slack, source, accept });
  } finally {
    await source.stop();
    await slack.close();
  }
}
