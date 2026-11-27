import { describe, expect, it } from "vitest";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { SessionEventBus } from "./bus.js";
import { InteractiveSessionStream } from "./stream.js";
import type { SessionStreamSource } from "./stream-subscriber.js";

const id = "12345678-1234-1234-1234-123456789abc";

function setup(overrides: Partial<SessionStreamSource> = {}) {
  const reported: unknown[] = [];
  const service = {
    authorizeStream: async () => ({
      organizationId: "org",
      userId: "user",
      role: "member" as const,
    }),
    streamEvents: async () => [],
    streamEventData: async () => undefined,
    streamCatchUp: async () => ({ gap: "behind" as const }),
    ...overrides,
  };
  const stream = new InteractiveSessionStream({
    service,
    bus: new SessionEventBus(),
    settings: { ...readRunProgressSettings({}), streamMaxPerKey: 1 },
    reportFailure: (error) => reported.push(error),
  });
  const open = (after = "", headers: HeadersInit = {}) =>
    stream.handle(new Request(`https://hub.test/events?organization=org${after}`, { headers }), id);
  return { stream, open, reported };
}

describe("interactive session response admission", () => {
  it("checks method, shutdown, id, and authorization before opening", async () => {
    const { stream } = setup({ authorizeStream: async () => "unauthorized" });
    const request = new Request("https://hub.test/events?after=bad");
    expect((await stream.handle(request, "invalid")).status).toBe(404);
    expect((await stream.handle(request, id)).status).toBe(401);
    await stream.beginShutdown();
    expect((await stream.handle(request, id)).status).toBe(503);
    const post = new Request(request.url, { method: "POST" });
    const response = await stream.handle(post, id);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("validates reconnect cursor components and releases the per-user limit on cancel", async () => {
    const { open, stream } = setup();
    for (const cursor of [
      "",
      "1:2.0:e",
      "1:2.65537:e",
      "9007199254740992",
      "1:9007199254740992:e",
      "1:2:\t",
    ]) {
      expect((await open(`&after=${encodeURIComponent(cursor)}`)).status).toBe(400);
    }
    const first = await open("&after=invalid", { "last-event-id": "2:3.65536:test:epoch" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(stream.activeStreamCount()).toBe(1);
    const limited = await open();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    await first.body?.cancel();
    expect(stream.activeStreamCount()).toBe(0);
    await (await open()).body?.cancel();
  });

  it("reports a thrown authorization error and rechecks shutdown after awaiting access", async () => {
    const failure = new Error("authorization fixture failed");
    const failed = setup({
      authorizeStream: async () => {
        throw failure;
      },
    });
    expect((await failed.open()).status).toBe(503);
    expect(failed.reported).toEqual([failure]);
    const access =
      Promise.withResolvers<Awaited<ReturnType<SessionStreamSource["authorizeStream"]>>>();
    const { stream, open } = setup({ authorizeStream: () => access.promise });
    const pending = open();
    await stream.beginShutdown();
    access.resolve({ organizationId: "org", userId: "user", role: "member" });
    expect((await pending).headers.get("retry-after")).toBe("5");
    expect(stream.activeStreamCount()).toBe(0);
  });
});
