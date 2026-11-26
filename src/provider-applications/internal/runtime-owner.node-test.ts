import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDatabase } from "../../db/memory.js";
import type { ProviderRegistration } from "../../providers/registration.js";
import { DynamicProviderRuntime } from "./runtime-owner.js";

const origin = "https://hub.test";
const configuration = {
  provider: "slack" as const,
  transport: "socket" as const,
  appId: "A1",
  appToken: "xapp-test",
};
const started = new Request(`${origin}/start`);

function registration(
  id: string,
  trace: string[],
  start: () => Promise<Response>,
): ProviderRegistration {
  return {
    connection: {
      name: "slack",
      actions: { start },
      status: () => ({ id }),
    },
    triggerProviders: [],
    sources: [
      {
        start: () => Promise.resolve(void trace.push(`start:${id}`)),
        stop: () => Promise.resolve(void trace.push(`stop:${id}`)),
      },
    ],
    outputs: [],
    requests: [],
  };
}

function runtime(
  registrationFactory: NonNullable<
    ConstructorParameters<typeof DynamicProviderRuntime>[0]["registrationFactory"]
  >,
) {
  const unused = () => Promise.reject(new Error("unused"));
  return new DynamicProviderRuntime({
    database: createMemoryDatabase(),
    auth: {
      handle: unused,
      resources: unused,
      resolveOrganizationAccess: unused,
      resolveAccount: unused,
      rejectCookieMutation: () => undefined,
      close: () => Promise.resolve(),
    },
    applicationBaseUrl: origin,
    registrationFactory,
  });
}

void test("an in-flight connection keeps its selected registration through publication", async () => {
  const trace: string[] = [];
  const inflight = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  const owner = runtime(({ configurationVersion }) =>
    registration(String(configurationVersion), trace, () => {
      if (configurationVersion === 1) {
        entered.resolve();
        return inflight.promise;
      }
      return Promise.resolve(Response.json({ url: "https://slack.test/v2" }));
    }),
  );
  assert.equal(owner.prepare.length, 6);
  assert.deepEqual(
    owner.registrations().map((entry) => entry.connection.name),
    ["github", "discord", "slack", "linear"],
  );
  const stable = owner.registrations().find(({ connection }) => connection.name === "slack");
  const source = stable?.sources[0];
  const start = stable?.connection.actions["start"];
  assert.ok(source);
  assert.ok(start);
  assert.equal((await start(started)).status, 409);
  await source.start(() => Promise.resolve());
  const first = await owner.prepare(
    "slack",
    configuration,
    origin,
    { provider: "slack", id: "1", name: "First" },
    1,
  );
  await first.start();
  first.publish();
  const pending = start(started);
  await entered.promise;
  const second = await owner.prepare(
    "slack",
    configuration,
    origin,
    { provider: "slack", id: "2", name: "Second" },
    2,
  );
  await second.start();
  second.publish();
  assert.deepEqual(await (await start(started)).json(), { url: "https://slack.test/v2" });
  inflight.resolve(Response.json({ url: "https://slack.test/v1" }));
  assert.deepEqual(await (await pending).json(), { url: "https://slack.test/v1" });
  assert.equal(owner.identity("slack")?.id, "2");
  await first.close();
  await source.stop();
  assert.deepEqual(trace, ["start:1", "start:2", "stop:1", "stop:2"]);
});

void test("rejects candidate connection responses that do not contain a usable URL", async () => {
  const cases = [
    () => Promise.resolve(Response.json({ url: "ignored" }, { status: 409 })),
    () => Promise.resolve(Response.json({ url: false })),
    () => Promise.resolve(Response.json(null)),
  ];
  for (const start of cases) {
    const owner = runtime(() => registration("1", [], start));
    const candidate = await owner.prepare(
      "slack",
      configuration,
      origin,
      { provider: "slack", id: "1", name: "First" },
      1,
    );
    const begin = candidate.beginConnection?.(started);
    assert.ok(begin);
    await assert.rejects(begin, {
      name: "ProviderRuntimeUnavailableError",
      code: "provider_application_unavailable",
      message: "provider application unavailable",
    });
  }
});
