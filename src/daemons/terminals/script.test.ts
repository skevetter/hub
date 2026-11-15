import { expect, test } from "vitest";
import { DaemonResponseLostError } from "../protocol.js";
import { FakeClock, FakeTerminalDaemon } from "../test-utils/fake-terminal-daemon.js";
import {
  MAX_OUTPUT_TAIL_BYTES,
  runScript,
  SCRIPT_PERMISSION_MESSAGE,
  ScriptRunAborted,
  TERMINAL_ENDED_MESSAGE,
  type ScriptRunInput,
} from "./script.js";

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
  const run = () => runScript(daemon.client, input, clock);
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
  expect(wrapper).toContain('HUB_EVENT_JSON="$2" /bin/sh -c "$1"');
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

test("a capture that fails for another reason fails the run and still kills", async () => {
  const { daemon, run } = setup();
  daemon.captureError = "terminal worker unavailable";
  const result = await run();
  expect(result.status).toBe("failed");
  expect(result.failureReason).toContain("terminal worker unavailable");
  expect(daemon.killed).toEqual(["terminal-1"]);
});
