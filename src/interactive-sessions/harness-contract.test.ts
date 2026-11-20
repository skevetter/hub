import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { HubHarness } from "../daemons/test-utils/hub-harness.js";
import { getApplication } from "../server/runtime.js";

it("the existing daemon harness accepts an interactive create without Hub MCP", async () => {
  const harness = await HubHarness.start();
  try {
    const daemonId = await harness.connectDaemon();
    const agents = (await getApplication()).hub.connectionForDaemon(daemonId)?.agents;
    assert.ok(agents);
    const options = { provider: "opencode", cwd: "/workspace", env: {}, background: false };
    const controlId = randomUUID();
    await expect(
      agents.create(
        controlId,
        {
          ...options,
          mcpServers: { hub: { type: "http", url: "https://hub.test/executions/" + controlId } },
        },
        2000,
      ),
    ).resolves.toMatchObject({ id: "agent-" + controlId, status: "running" });
    const sessionKey = "isession:" + randomUUID() + ":1";
    await expect(agents.create(sessionKey, options, 2000)).resolves.toMatchObject({
      id: "agent-" + sessionKey,
      status: "idle",
    });
    await expect(agents.create(sessionKey, options, 2000)).resolves.toMatchObject({
      id: "agent-" + sessionKey,
    });
    expect(harness.createdAgentCount()).toBe(2);
    await expect(agents.create(randomUUID(), options, 100)).rejects.toThrow(
      "daemon response was lost",
    );
    await expect(agents.create("isession:malformed:1", options, 100)).rejects.toThrow(
      "daemon response was lost",
    );
    expect(harness.createdAgentCount()).toBe(2);
  } finally {
    await harness.stop();
  }
}, 120_000);
