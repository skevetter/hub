import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SendAgentMessageResponseMessageSchema } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { DaemonAgents } from "../daemons/agents/index.js";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { HubDaemonServerInfoEnvelopeSchema } from "../hub/protocol.js";
import { HubE2E } from "./harness/index.js";
import { SourcePaseo } from "./harness/source-paseo.js";

const describeRealAgent = process.env["RUN_HUB_REAL_AGENT_E2E"] === "1" ? describe : describe.skip;

async function connectAgentAdapter(daemonHost: string, dropSendAcknowledgement = false) {
  const socket = await vi.waitFor(
    async () => {
      const candidate = new WebSocket(`ws://${daemonHost}/ws`, { handshakeTimeout: 5_000 });
      await once(candidate, "open");
      return candidate;
    },
    { timeout: 15_000, interval: 100 },
  );
  const agents = new DaemonAgents((frame) => socket.send(frame));
  const closed = new Promise<void>((resolveClose) => {
    socket.once("close", () => {
      agents.close();
      resolveClose();
    });
  });
  socket.on("error", () => socket.terminate());
  onTestFinished(async () => {
    socket.terminate();
    await closed;
  });

  let ready = false;
  let dropped = false;
  socket.on("message", (data) => {
    assert(Buffer.isBuffer(data));
    const frame: unknown = JSON.parse(data.toString());
    const session = z.object({ type: z.literal("session"), message: z.unknown() }).safeParse(frame);
    const acknowledgement = SendAgentMessageResponseMessageSchema.safeParse(
      session.data?.message,
    ).data;
    // Only drop a successful response, so replay follows a send the daemon already accepted.
    if (dropSendAcknowledgement && acknowledgement?.payload.accepted) {
      dropped = true;
      socket.terminate();
      return;
    }
    agents.receive(frame);
    if (HubDaemonServerInfoEnvelopeSchema.safeParse(frame).success) ready = true;
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientType: "cli",
      clientId: randomUUID(),
      protocolVersion: 1,
    }),
  );
  await vi.waitFor(() => assert(ready, "expected daemon server info"), { timeout: 10_000 });
  return { agents, droppedAcknowledgement: () => dropped };
}

describeRealAgent("Hub interactive session daemon adapter", () => {
  it("shows one user row with the sent message id after replaying a dropped acknowledgement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hub-replay-"));
    onTestFinished(() => rm(workspace, { recursive: true, force: true }));
    await promisify(execFile)("git", ["init", "--quiet", workspace]);
    const source = await SourcePaseo.start();
    onTestFinished(async () => assert.deepEqual((await source.stop()).leakedProcesses, []));
    const codexHome = join(workspace, "codex-home");
    await mkdir(codexHome);
    // Admission and receipts need a real harness but do not require a model response.
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model_provider = "hub_e2e"',
        "[model_providers.hub_e2e]",
        'name = "Hub E2E"',
        `base_url = "http://${source.paths.daemonHost}/e2e-no-inference"`,
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
      ].join("\n"),
    );
    const original = await connectAgentAdapter(source.paths.daemonHost, true);
    const agent = await original.agents.create(randomUUID(), {
      provider: "codex",
      cwd: workspace,
      env: { CODEX_HOME: codexHome },
    });
    const messageId = randomUUID();
    const prompt = "Reply with ACK.";

    await assert.rejects(
      original.agents.send(agent.id, messageId, prompt),
      DaemonResponseLostError,
    );
    assert.equal(original.droppedAcknowledgement(), true);

    const replacement = await connectAgentAdapter(source.paths.daemonHost);
    await replacement.agents.send(agent.id, messageId, prompt);
    const page = await replacement.agents.timeline(agent.id, { direction: "tail", limit: 50 });
    const userRows = page.entries
      .map((entry) => entry.item)
      .filter((item) => item.type === "user_message");
    assert.deepEqual(
      userRows.map((row) => ({ text: row.text, messageId: row.messageId })),
      [{ text: prompt, messageId }],
    );
  }, 300_000);
});

describeRealAgent("Hub execution MCP real-agent smoke", () => {
  let hub: HubE2E;

  beforeEach(async () => {
    hub = await HubE2E.start({ realAgent: true });
  }, 120_000);

  afterEach(async () => {
    const shutdown = await hub?.stop();
    assert.deepEqual(shutdown?.leakedProcesses ?? [], []);
  }, 120_000);

  it("continues a real Codex session after workspace archival", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.enableAgentContinuation(true);
    const first = await hub.runRealAgentManual("real-continuation-first");
    const firstEvidence = await hub.realAgentCompletionEvidence(first, "codex");
    assert.equal(firstEvidence.completedByAgent, true);
    await hub.sessionIsArchived(first.executionId);
    const second = await hub.runRealAgentManual("real-continuation-second");
    assert.equal(second.agentId, first.agentId);
    const secondEvidence = await hub.realAgentCompletionEvidence(second, "codex");
    assert.equal(secondEvidence.status, "succeeded");
    assert.equal(secondEvidence.completedByAgent, true);
    assert.equal(secondEvidence.completedToolCall, true);
  }, 300_000);

  it("lets a real Codex agent finalize a production manual run through MCP", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration("codex");

    const run = await hub.runRealAgentManual("real-agent-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run, "codex");

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);

  it("lets a real Claude agent finalize a production manual run through MCP", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration("claude");

    const run = await hub.runRealAgentManual("real-claude-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run, "claude");

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);

  it("lets a permissioned real OpenCode agent finalize through preapproved Hub MCP", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration("opencode");

    const run = await hub.runRealAgentManual("real-opencode-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run, "opencode");

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);

  it("routes deterministic input and classifier fallback through the real daemon", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentRoutingConfiguration("codex");

    const deterministicRun = await hub.runRealAgentRouting(
      "routing-deterministic",
      "repo=paseo task",
    );
    const deterministic = await hub.realAgentRoutingEvidence(deterministicRun, "codex");
    assert.deepEqual(
      deterministic.steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work-paseo", "succeeded"],
        ["work-hub", "skipped"],
      ],
    );

    const classifiedRun = await hub.runRealAgentRouting("routing-classifier", "investigate");
    const classified = await hub.realAgentRoutingEvidence(classifiedRun, "codex");
    assert.deepEqual(
      classified.steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "succeeded"],
        ["work-paseo", "skipped"],
        ["work-hub", "succeeded"],
      ],
    );
    assert.deepEqual(classified.steps[0]?.output, { repo: "hub" });
  }, 600_000);

  it("routes classifier fallback through a real Claude multi-step workflow", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentRoutingConfiguration("claude");

    const run = await hub.runRealAgentRouting(
      "claude-routing-classifier",
      "investigate Hub workflows",
    );
    const evidence = await hub.realAgentRoutingEvidence(run, "claude");

    assert.deepEqual(
      evidence.steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "succeeded"],
        ["work-paseo", "skipped"],
        ["work-hub", "succeeded"],
      ],
    );
    assert.deepEqual(evidence.steps[0]?.output, { repo: "hub" });
  }, 600_000);
});
