import { describe, expect, it } from "vitest";
import { FakeClock, FakeTerminalDaemon } from "../test-utils/fake-terminal-daemon.js";
import { createScriptStepRunner, runScript } from "./script.js";

const scope = { cwd: "/repo", workspaceId: "ws-1" };
const input = {
  ...scope,
  name: "hub-script-test",
  script: "true",
  eventJson: "{}",
  timeoutMs: 500,
};

describe("script runner boundaries", () => {
  it("rethrows the same Error from polling after cleanup", async () => {
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    const reason = new RangeError("sleep failed");
    clock.sleep = async () => Promise.reject(reason);
    await expect(runScript(daemon.client, input, clock)).rejects.toBe(reason);
    expect(daemon.killed).toEqual(["terminal-1"]);
  });

  it.each([{ detail: "sleep failed" }, "sleep failed"])(
    "wraps a non-Error rejection from polling after cleanup (%s)",
    async (reason) => {
      const daemon = new FakeTerminalDaemon();
      const clock = new FakeClock();
      clock.sleep = async () => Promise.reject(reason);
      const run = runScript(daemon.client, input, clock);
      await expect(run).rejects.toThrow("Script run failed with a non-Error value");
      const error: unknown = await run.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected a wrapped rejection");
      expect(error.cause).toBe(reason);
      expect(daemon.killed).toEqual(["terminal-1"]);
    },
  );

  it("uses its fallback failure when polling rejects with undefined", async () => {
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.sleep = async () => Promise.reject(undefined);
    const result = await runScript(daemon.client, input, clock);
    expect(result.failureReason).toBe(
      "The script terminal failed: script run ended without an outcome",
    );
    expect(daemon.killed).toEqual(["terminal-1"]);
  });

  it("preserves the error on a sparse capture and still cleans up", async () => {
    const daemon = new FakeTerminalDaemon();
    const lines: string[] = [];
    lines.length = 3;
    daemon.client.capture = async () => ({ lines, totalLines: 3 });
    await expect(runScript(daemon.client, input, new FakeClock())).rejects.toThrow(
      "Cannot read properties of undefined (reading 'trimEnd')",
    );
    expect(daemon.killed).toEqual(["terminal-1"]);
  });

  it("drops a partial UTF-8 character and trailing blank lines from the tail", async () => {
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    const suffix = "x".repeat(65_535);
    clock.at(250, () => {
      daemon.print(`\u{1F600}${suffix}\n \n\t`);
      daemon.exit(0);
    });
    const result = await runScript(daemon.client, input, clock);
    expect(result).toEqual({
      status: "succeeded",
      exitCode: 0,
      outputTail: suffix,
      truncated: true,
    });
  });

  it("visits sweep candidates in order and reports an unconfirmed stop", async () => {
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    const runner = createScriptStepRunner(() => ({ terminals: daemon.client }), clock, {
      sleep: async () => {},
      random: () => 0,
    });
    const names = ["other", "hub-script-owned", "hub-script-left"];
    for (const name of names) {
      await daemon.client.create({
        ...scope,
        name,
        command: "true",
        args: [],
        size: { rows: 1, cols: 1 },
      });
    }
    daemon.killSucceeds = false;
    const visited: string[] = [];
    const result = await runner.sweep("daemon", scope, async (name) => {
      visited.push(name);
      return name === "hub-script-owned";
    });
    expect(visited).toEqual(names.slice(1));
    expect(result).toEqual({ stopped: 0, unconfirmed: 1 });
    expect(daemon.killAttempts).toEqual(Array<string>(5).fill("terminal-3"));
  });
});
