import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => ({
    validator: () => ({
      handler: (_rpc: unknown, handler: unknown) => ({ __executeServer: handler }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("../server/runtime.js", () => ({
  getApplication: vi.fn(async () => ({ interactiveSessions: null })),
}));

import { handleInteractiveSessionEvents } from "../routes/api/v1/interactive-sessions/$sessionId/events.js";

type TestHandler = (input: { data: unknown }) => Promise<unknown>;
let handlers: object;
function isTestHandler(value: unknown): value is TestHandler {
  return typeof value === "function";
}
beforeAll(async () => {
  // The SSR wrapper contains an RPC stub. Exercise the implementations split out by Start.
  const provider = "./functions.ts?tss-serverfn-split";
  const loaded: unknown = await import(provider);
  if (typeof loaded !== "object" || loaded === null) throw new Error("Missing Start handlers");
  handlers = loaded;
});

describe("disabled interactive sessions", () => {
  const id = randomUUID();
  const scope = { organizationSlug: "org", sessionId: id };
  const control = { ...scope, generation: 1, idempotencyKey: id };
  const cases = [
    ["list", "listInteractiveSessions", { ...scope, filter: "all", cursor: null }],
    ["read", "readInteractiveSession", scope],
    ["history", "readSessionHistory", { ...scope, before: null, limit: 50 }],
    [
      "start",
      "startInteractiveSession",
      {
        ...scope,
        profileId: id,
        profileVersion: 1,
        message: "hello",
        participants: [],
        idempotencyKey: id,
      },
    ],
    ["send", "sendSessionMessage", { ...control, message: "hello", delivery: "steer" }],
    ["stop", "stopSession", control],
    ["close", "closeSession", control],
    ["replace", "replaceSessionAgent", control],
    ["participants", "setSessionParticipant", { ...scope, userId: "user", role: null }],
    ["profiles", "listSessionProfiles", scope],
    [
      "save profile",
      "saveSessionProfile",
      {
        ...scope,
        id: null,
        version: null,
        name: "Profile",
        daemonId: id,
        cwd: "/repo",
        worktree: null,
        provider: "omp",
        model: null,
        mode: "ask",
        thinkingOptionId: null,
        fullAccessAcknowledged: false,
        status: "active",
      },
    ],
  ] as const;
  it.each(cases)("%s answers not_found", async (_name, fn, data) => {
    const call: unknown = Reflect.get(handlers, fn + "_createServerFn_handler");
    if (!isTestHandler(call)) throw new Error("Missing Start handler for " + fn);
    await expect(call({ data })).resolves.toEqual({
      status: "ok",
      data: { outcome: "refused", code: "not_found" },
    });
  });
  it.each(["GET", "HEAD", "POST"])("the %s route answers 404", async (method) => {
    const response = await handleInteractiveSessionEvents({
      request: new Request("https://hub.test/events?organization=org", { method }),
      params: { sessionId: id },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
