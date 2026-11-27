import { expect, test } from "vitest";
import { DaemonResponseLostError } from "../protocol.js";
import { FakeClock, FakeTerminalDaemon } from "../test-utils/fake-terminal-daemon.js";
import {
  createScriptStepRunner,
  MAX_OUTPUT_TAIL_BYTES,
  runScript,
  scriptWrapper,
  sweepScriptTerminals,
  SCRIPT_PERMISSION_MESSAGE,
  ScriptRunAborted,
  TERMINAL_ENDED_MESSAGE,
  type ScriptRunInput,
} from "./script.js";

/** Retries run at once, so no real time passes between kill attempts. */
const NO_WAIT = { sleep: async () => undefined, random: () => 0 };

function setup(overrides: Partial<ScriptRunInput> = {}) {
  const daemon = new FakeTerminalDaemon();
  const clock = new FakeClock();
  const input: ScriptRunInput = {
    cwd: "/work/webapp",
    script: "echo hi",
    eventJson: '{"a":1}',
    name: "hub-script-step",
    timeoutMs: 10 * 60_000,
    ...overrides,
  };
  const run = () => runScript(daemon.client, input, clock, NO_WAIT);
  return { daemon, clock, input, run };
}

test("exit 0 succeeds with the output before the marker and kills the terminal", async () => {
  const { daemon, clock, run } = setup();
  clock.at(500, () => {
    daemon.print("building\nall good");
    daemon.exit(0);
  });
  const result = await run();
  expect(result).toEqual({
    status: "succeeded",
    exitCode: 0,
    outputTail: "building\nall good",
    truncated: false,
  });
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a nonzero exit fails with the script exit reason", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.print("boom");
    daemon.exit(3);
  });
  const result = await run();
  expect(result).toMatchObject({
    status: "failed",
    exitCode: 3,
    outputTail: "boom",
    failureReason: "script exited 3",
  });
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a half-written marker is not read as a shorter exit code", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.print("out");
    daemon.terminal.lines.push("", `__HUB_EXIT_${daemon.markerId()}__:1`);
  });
  clock.at(500, () => {
    daemon.terminal.lines.pop();
    daemon.terminal.lines.push(`__HUB_EXIT_${daemon.markerId()}__:127:`);
  });
  const result = await run();
  expect(result).toMatchObject({ status: "failed", exitCode: 127, outputTail: "out" });
});

test("a marker typed by the script under another id is ordinary output", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.print("__HUB_EXIT_other-id__:0:");
    daemon.exit(2);
  });
  const result = await run();
  expect(result).toMatchObject({ exitCode: 2, outputTail: "__HUB_EXIT_other-id__:0:" });
});

test("output beyond 64 KB is cut from the front and flagged", async () => {
  const { daemon, clock, run } = setup();
  const line = "x".repeat(240);
  clock.at(250, () => {
    daemon.print(Array.from({ length: 300 }, (_, index) => `${String(index)}${line}`).join("\n"));
    daemon.exit(0);
  });
  const result = await run();
  expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(MAX_OUTPUT_TAIL_BYTES);
  expect(result.truncated).toBe(true);
  expect(result.outputTail.endsWith(`299${line}`)).toBe(true);
});

test("output that scrolled out of the capture window is flagged as truncated", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.terminal.scrolledOff = 5_000;
    daemon.print("last line");
    daemon.exit(0);
  });
  const result = await run();
  expect(result).toMatchObject({ status: "succeeded", outputTail: "last line", truncated: true });
});

test("ANSI sequences are stripped from the tail", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.print("\u001b[31mred\u001b[0m text");
    daemon.exit(0);
  });
  expect((await run()).outputTail).toBe("red text");
});

test("a terminal that vanishes before the marker fails with a clear reason", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => daemon.print("starting"));
  clock.at(1_000, () => daemon.remove());
  const result = await run();
  expect(result).toMatchObject({
    status: "failed",
    exitCode: null,
    outputTail: "starting",
    failureReason: TERMINAL_ENDED_MESSAGE,
  });
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a silent script is not mistaken for a vanished terminal", async () => {
  const { daemon, clock, run } = setup();
  clock.at(30_000, () => daemon.exit(0));
  const result = await run();
  expect(result).toMatchObject({ status: "succeeded", exitCode: 0, outputTail: "" });
});

test("polling slows from 250 ms to 1 s after the first 10 seconds", async () => {
  const { daemon, clock, run } = setup();
  const times: number[] = [];
  const sleep = clock.sleep.bind(clock);
  clock.sleep = async (milliseconds) => {
    times.push(milliseconds);
    await sleep(milliseconds);
  };
  clock.at(12_000, () => daemon.exit(0));
  await run();
  expect(times.slice(0, 3)).toEqual([250, 250, 250]);
  expect(times.at(-1)).toBe(1_000);
});

test("the deadline kills the terminal and reports a timeout with the last output", async () => {
  const { daemon, clock, run } = setup({ timeoutMs: 5_000 });
  clock.at(250, () => daemon.print("still working"));
  const result = await run();
  expect(result).toMatchObject({
    status: "timed_out",
    exitCode: null,
    outputTail: "still working",
  });
  expect(daemon.killed).toEqual(["terminal-1"]);
  expect(clock.time).toBeGreaterThanOrEqual(5_000);
});

test("a permission refusal on create maps to the grant instructions", async () => {
  const { daemon, run } = setup();
  daemon.denied.add("create_terminal_request");
  const result = await run();
  expect(result).toMatchObject({
    status: "failed",
    exitCode: null,
    failureReason: SCRIPT_PERMISSION_MESSAGE,
  });
  expect(SCRIPT_PERMISSION_MESSAGE).toContain("paseo hub permissions grant workspace.write");
  expect(SCRIPT_PERMISSION_MESSAGE).toContain("paseo hub permissions grant workspace.read");
  expect(daemon.killed).toEqual([]);
});

test("a permission refusal on capture maps to the grant instructions and still kills", async () => {
  const { daemon, run } = setup();
  daemon.denied.add("capture_terminal_request");
  const result = await run();
  expect(result.failureReason).toBe(SCRIPT_PERMISSION_MESSAGE);
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a working directory that is not an open project says how to fix it", async () => {
  const { daemon, run } = setup();
  daemon.createError = "workspaceId is required";
  const result = await run();
  expect(result.failureReason).toBe(
    "Open /work/webapp as a project in Paseo on that host, then retry.",
  );
});

test("any other daemon refusal is reported with the daemon's words", async () => {
  const { daemon, run } = setup();
  daemon.createError = "spawn failed";
  expect((await run()).failureReason).toBe("The daemon refused the script terminal: spawn failed");
});

test("the script and event are separate argv elements and never in the shell string", async () => {
  const script = `echo "$(rm -rf /)"; echo 'it''s'; cat <<EOF\nline\nEOF`;
  const eventJson = JSON.stringify({ title: `'; touch /tmp/pwned; echo '`, body: "$(id)" });
  const { daemon, clock, run } = setup({ script, eventJson });
  clock.at(250, () => daemon.exit(0));
  await run();
  const [created] = daemon.created;
  expect(created?.command).toBe("/bin/sh");
  expect(created?.name).toBe("hub-script-step");
  expect(created?.size).toEqual({ rows: 50, cols: 240 });
  expect(created?.cwd).toBe("/work/webapp");
  const args = created?.args ?? [];
  expect(args).toHaveLength(5);
  expect(args[0]).toBe("-c");
  expect(args[2]).toBe("sh");
  expect(args[3]).toBe(script);
  expect(args[4]).toBe(eventJson);
  const wrapper = args[1] ?? "";
  expect(wrapper).toContain('HUB_EVENT_JSON="$2" /bin/sh -c -- "$1"');
  expect(wrapper).toContain("sleep 30");
  expect(wrapper).toContain(`__HUB_EXIT_${daemon.markerId()}__:%s:`);
  expect(wrapper).not.toContain("rm -rf");
  expect(wrapper).not.toContain("pwned");
  expect(wrapper).not.toContain("echo");
});

test("each run gets a fresh marker", async () => {
  const first = setup();
  first.clock.at(250, () => first.daemon.exit(0));
  await first.run();
  const clock = first.clock;
  const second = new FakeTerminalDaemon();
  clock.at(clock.time + 250, () => second.exit(0));
  await runScript(second.client, first.input, clock);
  expect(second.markerId()).not.toBe(first.daemon.markerId());
});

test("the terminal id is handed over before the first poll", async () => {
  const seen: string[] = [];
  const { daemon, clock, run } = setup({
    onTerminal: async ({ id }) => {
      seen.push(id);
      expect(daemon.requests.map((request) => request["type"])).toEqual([
        "create_terminal_request",
      ]);
    },
  });
  clock.at(250, () => daemon.exit(0));
  await run();
  expect(seen).toEqual(["terminal-1"]);
});

test("a failure to record the terminal kills it and fails the run", async () => {
  const { daemon, run } = setup({
    onTerminal: async () => {
      throw new Error("database unavailable");
    },
  });
  const result = await run();
  expect(result).toMatchObject({ status: "failed", exitCode: null });
  expect(result.failureReason).toContain("database unavailable");
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a lost create response kills any terminal left under the run's name", async () => {
  const { daemon, run } = setup();
  const created = daemon.client.create.bind(daemon.client);
  daemon.client.create = async (options) => {
    await created(options);
    throw new DaemonResponseLostError();
  };
  const result = await run();
  expect(result.status).toBe("failed");
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("aborting stops polling, kills the terminal, and throws", async () => {
  const controller = new AbortController();
  const { daemon, clock, run } = setup({ signal: controller.signal });
  clock.at(500, () => controller.abort());
  await expect(run()).rejects.toBeInstanceOf(ScriptRunAborted);
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a capture that fails is asked again until the script reports", async () => {
  const { daemon, clock, run } = setup();
  daemon.captureError = "terminal worker unavailable";
  clock.at(3_000, () => {
    daemon.captureError = undefined;
    daemon.print("recovered");
    daemon.exit(0);
  });
  const result = await run();
  expect(result).toMatchObject({ status: "succeeded", exitCode: 0, outputTail: "recovered" });
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a capture that never recovers times the run out at its deadline and still kills", async () => {
  const { daemon, run } = setup({ timeoutMs: 5_000 });
  daemon.captureError = "terminal worker unavailable";
  const result = await run();
  expect(result).toMatchObject({ status: "timed_out", exitCode: null });
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("liveness checks list by the workspace the daemon chose, name recovery by directory", async () => {
  const { daemon, clock, run } = setup();
  clock.at(1_000, () => daemon.exit(0));
  await run();
  expect(daemon.listRequests[0]).toMatchObject({
    type: "list_terminals_request",
    workspaceId: "ws-1",
  });
  expect(daemon.listRequests[0]).not.toHaveProperty("cwd");

  const lost = setup();
  lost.daemon.client.create = async () => {
    throw new DaemonResponseLostError();
  };
  await lost.run();
  expect(lost.daemon.listRequests[0]).toMatchObject({ cwd: "/work/webapp" });
  expect(lost.daemon.listRequests[0]).not.toHaveProperty("workspaceId");
});

test("a kill that fails is retried until the daemon confirms it", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => daemon.exit(0));
  daemon.failKills = 2;
  const result = await run();
  expect(result.status).toBe("succeeded");
  expect(result).not.toHaveProperty("cleanup");
  expect(daemon.killAttempts).toEqual(["terminal-1", "terminal-1", "terminal-1"]);
  expect(daemon.killed).toEqual(["terminal-1"]);
});

test("a kill that answers success false for a terminal that is already gone is confirmed", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.exit(0);
  });
  const taken = daemon.client.capture.bind(daemon.client);
  daemon.client.capture = async (terminalId, start) => {
    const capture = await taken(terminalId, start);
    // The daemon drops the terminal right after the marker was read.
    if (capture.lines.length > 0) daemon.remove();
    return capture;
  };
  const result = await run();
  expect(result.status).toBe("succeeded");
  expect(result).not.toHaveProperty("cleanup");
  expect(daemon.killAttempts).toEqual(["terminal-1"]);
});

test("a kill answered success false for a terminal that is still listed is retried, then reported", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => daemon.exit(0));
  daemon.killSucceeds = false;
  const result = await run();
  expect(result.status).toBe("succeeded");
  expect(result.cleanup).toEqual({
    cwd: "/work/webapp",
    name: "hub-script-step",
    terminalId: "terminal-1",
    workspaceId: "ws-1",
  });
  expect(daemon.killAttempts).toHaveLength(5);
});

test("a kill the daemon keeps failing is reported as a pending cleanup", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => daemon.exit(3));
  daemon.failKills = 99;
  const result = await run();
  expect(result).toMatchObject({ status: "failed", exitCode: 3 });
  expect(result.cleanup?.terminalId).toBe("terminal-1");
  expect(daemon.killAttempts).toHaveLength(5);
});

test("a permission refusal on kill is reported at once without retries", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => daemon.exit(0));
  daemon.denied.add("kill_terminal_request");
  const result = await run();
  expect(result.cleanup?.terminalId).toBe("terminal-1");
  expect(daemon.killAttempts).toHaveLength(0);
  expect(
    daemon.requests.filter((request) => request["type"] === "kill_terminal_request"),
  ).toHaveLength(1);
});

test("a lost create response whose terminal cannot be found again is reported by name", async () => {
  const { daemon, run } = setup();
  daemon.client.create = async () => {
    throw new DaemonResponseLostError();
  };
  daemon.denied.add("list_terminals_request");
  const result = await run();
  expect(result.cleanup).toEqual({
    cwd: "/work/webapp",
    name: "hub-script-step",
    terminalId: undefined,
  });
});

test("a shutdown abort tries the kill once", async () => {
  const controller = new AbortController();
  const { daemon, clock, run } = setup({ signal: controller.signal });
  clock.at(500, () => controller.abort());
  daemon.killSucceeds = false;
  await expect(run()).rejects.toBeInstanceOf(ScriptRunAborted);
  expect(daemon.killAttempts).toHaveLength(1);
});

test("the terminal connection is looked up again on every call", async () => {
  const first = new FakeTerminalDaemon();
  const second = new FakeTerminalDaemon();
  const clock = new FakeClock();
  let current = first;
  let lookups = 0;
  const runner = createScriptStepRunner(
    () => {
      lookups += 1;
      return { terminals: current.client };
    },
    clock,
    NO_WAIT,
  );
  // The daemon reconnects mid-run: the new connection already holds the same terminal.
  clock.at(250, () => {
    void second.client.create({
      cwd: "/work/webapp",
      name: "hub-script-step",
      command: "/bin/sh",
      args: ["-c", scriptWrapper(clock.uuidFor(1)), "sh", "x", "{}"],
      size: { rows: 50, cols: 240 },
    });
    current = second;
  });
  clock.at(500, () => second.exit(0));
  const result = await runner.run("daemon-1", {
    cwd: "/work/webapp",
    script: "true",
    eventJson: "{}",
    name: "hub-script-step",
    timeoutMs: 60_000,
  });
  expect(result.status).toBe("succeeded");
  expect(lookups).toBeGreaterThan(3);
  expect(first.killed).toEqual([]);
  expect(second.killed).toEqual(["terminal-1"]);
});

test("a run on a daemon that is not connected says so and creates nothing", async () => {
  const runner = createScriptStepRunner(() => undefined, new FakeClock(), NO_WAIT);
  const result = await runner.run("daemon-1", {
    cwd: "/work",
    script: "true",
    eventJson: "{}",
    name: "n",
    timeoutMs: 1_000,
  });
  expect(result.failureReason).toMatch(/not connected/u);
});

test("a script that prints NUL and control bytes is recorded with its true exit code", async () => {
  const { daemon, clock, run } = setup();
  clock.at(250, () => {
    daemon.print("before\u0000after\u0001\u0007bell\u001b[2Jred\ttab\u007f end");
    daemon.exit(7);
  });
  const result = await run();
  expect(result).toMatchObject({
    status: "failed",
    exitCode: 7,
    outputTail: "beforeafterbellred\ttab end",
  });
  expect(JSON.stringify(result.outputTail)).not.toMatch(/\\u0000/u);
});

test("a silent script costs few liveness checks while it polls", async () => {
  const { daemon, clock, run } = setup();
  clock.at(30_000, () => daemon.exit(0));
  await run();
  const polls = daemon.requests.filter((request) => request["type"] === "capture_terminal_request");
  const lists = daemon.listRequests;
  // 250 ms for the first 10 s, then 1 s.
  expect(polls.length).toBeGreaterThanOrEqual(40 + 19);
  expect(polls.length).toBeLessThanOrEqual(40 + 21);
  // A liveness check at most every 2 s.
  expect(lists.length).toBeLessThanOrEqual(Math.ceil(30_000 / 2_000) + 1);
});

test("sweeping stops leftover script terminals that nothing claims", async () => {
  const daemon = new FakeTerminalDaemon();
  const make = (name: string) =>
    daemon.client.create({
      cwd: "/work/webapp",
      name,
      command: "/bin/sh",
      args: [],
      size: { rows: 50, cols: 240 },
    });
  await make("hub-script-live");
  await make("hub-script-leftover");
  await make("somebody-elses");
  const result = await sweepScriptTerminals({
    terminals: daemon.client,
    scope: { cwd: "/work/webapp" },
    keep: (name) => name === "hub-script-live",
    clock: new FakeClock(),
    retry: NO_WAIT,
  });
  expect(result).toEqual({ stopped: 1, unconfirmed: 0 });
  expect(daemon.killed).toEqual(["terminal-2"]);
});

test("a capture that keeps failing for a terminal the daemon no longer lists ends the run quickly", async () => {
  const { daemon, clock, run } = setup({ timeoutMs: 10 * 60_000 });
  daemon.captureError = "terminal worker unavailable";
  clock.at(1_000, () => daemon.remove());
  const result = await run();
  expect(result).toMatchObject({
    status: "failed",
    exitCode: null,
    failureReason: TERMINAL_ENDED_MESSAGE,
  });
  // Well before the ten-minute deadline would have freed the slot.
  expect(clock.time).toBeLessThan(10_000);
  expect(daemon.killAttempts).toEqual(["terminal-1"]);
});

test("a capture that keeps failing for a terminal that is still listed is not ended early", async () => {
  const { daemon, run } = setup({ timeoutMs: 30_000 });
  daemon.captureError = "terminal worker unavailable";
  const result = await run();
  expect(result.status).toBe("timed_out");
});

test("a daemon that cannot be asked at all is waited for, not given up on", async () => {
  const { daemon, run } = setup({ timeoutMs: 30_000 });
  daemon.captureError = "terminal worker unavailable";
  daemon.denied.add("list_terminals_request");
  const result = await run();
  expect(result.status).toBe("timed_out");
});
