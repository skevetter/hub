import { WebSocket } from "ws";
import * as failures from "../../../../failures/index.js";
import * as connection from "./connection.js";
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

it("grows and caps reconnect backoff, honors retry-after, and resets after connecting", async () => {
  await withTransport(async ({ open, source, socket }) => {
    open.mockRejectedValueOnce(transientFailure(750));
    for (let index = 0; index < 5; index += 1) open.mockRejectedValueOnce(transientFailure());
    await connect(source);
    expect(source.status().state).toBe("connecting");

    for (const [index, delay] of [750, 1062, 2125, 4250, 8500, 15937].entries()) {
      await expectReconnectAfter(open, index + 1, delay);
    }
    expect(source.status().state).toBe("connected");

    socket.close(1006);
    await vi.advanceTimersByTimeAsync(0);
    await expectReconnectAfter(open, 7, 531);
    expect(source.status().state).toBe("connected");
  });
});

it("wakes a live backoff when retry is called", async () => {
  await withTransport(async ({ open, source }) => {
    open.mockRejectedValueOnce(transientFailure(5_000));
    await connect(source);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(1);

    await source.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(2);
    expect(source.status().state).toBe("connected");
  });
});

it("reports a failed ack send, closes the socket, and reconnects", async () => {
  await withTransport(async ({ open, source, socket, report }) => {
    const error = new Error("send failed");
    socket.ackError = error;
    await connect(source);
    emitFrame(socket, { type: "interactive", envelope_id: "ack-failure" });
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledWith('{"envelope_id":"ack-failure"}', expect.any(Function));
    expect(socket.close).toHaveBeenCalledWith();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({ operation: "slack.socket.ack" }),
      expect.objectContaining({ kind: "network" }),
    );
    await expectReconnectAfter(open, 1, 531);
    expect(source.status().state).toBe("connected");
  });
});

it("does not ack valid intake that finishes after stop begins", async () => {
  await withTransport(async ({ accept, source, socket }) => {
    const intake = Promise.withResolvers<Awaited<ReturnType<SlackSocketSourceOptions["accept"]>>>();
    accept.mockReturnValueOnce(intake.promise);
    await connect(source);
    emitFrame(socket, mentionEnvelope());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(accept).toHaveBeenCalledOnce();
      expect(socket.send).not.toHaveBeenCalled();
    } finally {
      const stopped = source.stop();
      intake.resolve({ status: "accepted", events: [], receiptId: "receipt" });
      await stopped;
    }
    expect(source.status().state).toBe("stopped");
    expect(socket.send).not.toHaveBeenCalled();
  });
});

it("reports an intake validation error and acknowledges without closing", async () => {
  await withTransport(async ({ accept, source, socket, report }) => {
    await connect(source);
    emitFrame(socket, {
      ...mentionEnvelope(),
      payload: { ...mentionEnvelope().payload, api_app_id: "A-WRONG" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(accept).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.any(Error),
      expect.objectContaining({ operation: "slack.socket.envelope.parse" }),
      expect.objectContaining({ kind: "validation" }),
    );
    expect(socket.send).toHaveBeenCalledWith('{"envelope_id":"mention"}', expect.any(Function));
    expect(socket.close).not.toHaveBeenCalled();
    expect(source.status().state).toBe("connected");
  });
});

it("passes a non-validation intake error to handoff failure handling and closes without ack", async () => {
  await withTransport(async ({ accept, source, socket, report }) => {
    const error = new Error("durable intake failed");
    accept.mockRejectedValueOnce(error);
    await connect(source);
    emitFrame(socket, mentionEnvelope());
    await vi.advanceTimersByTimeAsync(0);

    expect(accept).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({ operation: "slack.socket.handoff" }),
      expect.objectContaining({ kind: "internal" }),
    );
    expect(socket.close).toHaveBeenCalledWith();
    expect(socket.send).not.toHaveBeenCalled();
  });
});

it("does not ack binary, oversized, or disconnect frames", async () => {
  await withTransport(async ({ accept, source, socket, report }) => {
    await connect(source);
    emitFrame(socket, { type: "interactive", envelope_id: "binary" }, true);
    emitFrame(socket, {
      type: "interactive",
      envelope_id: "oversized",
      payload: "x".repeat(1_048_576),
    });
    emitFrame(socket, {
      type: "disconnect",
      reason: "refresh_requested",
      envelope_id: "disconnect",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(report.mock.calls.map(([, context]) => context.operation)).toEqual([
      "slack.socket.envelope.parse",
      "slack.socket.envelope.parse",
    ]);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(1000, "refresh_requested");
    expect(socket.send).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});

type SendCallback = (error?: Error) => void;

class TestSocket extends WebSocket {
  readonly closed = Promise.withResolvers<number>();
  ackError?: Error;

  override readonly send = vi.fn(
    (_data: unknown, optionsOrCallback?: object | SendCallback, callback?: SendCallback) => {
      const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      done?.(this.ackError);
    },
  );
  override readonly close = vi.fn((code: number = 1000, _reason?: string | Buffer) =>
    this.closed.resolve(code),
  );

  constructor() {
    super(null);
  }

  connection(): connection.OpenSlackSocketResult {
    return {
      appId: "A123",
      socket: this,
      closed: this.closed.promise,
      close: async (_timeoutMs, reason) => this.close(1000, reason),
    };
  }
}

function mockTransport() {
  const socket = new TestSocket();
  const open = vi.spyOn(connection, "openSlackSocket");
  let connected = false;
  open.mockImplementation(() => {
    const transport = connected ? new TestSocket() : socket;
    connected = true;
    return Promise.resolve(transport.connection());
  });
  return { socket, open };
}

function socketTestRig() {
  const { socket, open } = mockTransport();
  const report = vi.spyOn(failures, "reportFailure");
  const accept = vi.fn<SlackSocketSourceOptions["accept"]>();
  const source = createSlackSocketSource({
    appId: "A123",
    appToken: "test-token",
    random: () => 0.53125,
    accept,
  });
  return { socket, open, report, accept, source };
}

async function withTransport(run: (rig: ReturnType<typeof socketTestRig>) => Promise<void>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rig = socketTestRig();
  try {
    await run(rig);
  } finally {
    try {
      await rig.source.stop();
    } finally {
      rig.open.mockRestore();
      rig.report.mockRestore();
      vi.useRealTimers();
    }
  }
}

async function connect(source: ReturnType<typeof createSlackSocketSource>) {
  await source.start(() => Promise.resolve());
  await vi.advanceTimersByTimeAsync(0);
}

function transientFailure(retryAfterMs = 0) {
  return new connection.SlackSocketConnectionError("transient", "test_outage", retryAfterMs);
}

async function expectReconnectAfter(
  open: ReturnType<typeof mockTransport>["open"],
  previousAttempts: number,
  delay: number,
) {
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(open).toHaveBeenCalledTimes(previousAttempts);
  await vi.advanceTimersByTimeAsync(1);
  expect(open).toHaveBeenCalledTimes(previousAttempts + 1);
}

function emitFrame(socket: TestSocket, frame: unknown, binary = false) {
  socket.emit("message", Buffer.from(JSON.stringify(frame)), binary);
}

function mentionEnvelope() {
  return {
    type: "events_api",
    envelope_id: "mention",
    payload: {
      type: "event_callback",
      api_app_id: "A123",
      team_id: "T123",
      event_id: "E123",
      event_time: 1_700_000_000,
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C123",
        text: "<@UBOT> hello",
        ts: "1700000000.001",
        event_ts: "1700000000.001",
      },
    },
  };
}
