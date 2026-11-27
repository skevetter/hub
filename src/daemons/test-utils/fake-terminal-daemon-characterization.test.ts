import { describe, expect, it } from "vitest";
import { FakeTerminalDaemon } from "./fake-terminal-daemon.js";

describe("fake terminal kill responses", () => {
  it("distinguishes denied, transient, declined, stopped and already absent terminals", async () => {
    const daemon = new FakeTerminalDaemon();
    const terminal = await daemon.client.create({
      cwd: "/repo",
      name: "fake",
      command: "true",
      args: [],
      size: { rows: 1, cols: 1 },
    });
    const requestType = "kill_terminal_request";
    daemon.denied.add(requestType);
    await expect(daemon.client.kill(terminal.id)).rejects.toThrow("Operation not permitted");
    expect(daemon.killAttempts).toEqual([]);

    daemon.denied.delete(requestType);
    daemon.failKills = 1;
    await expect(daemon.client.kill(terminal.id)).rejects.toThrow("terminal worker busy");

    daemon.killSucceeds = false;
    await expect(daemon.client.kill(terminal.id)).resolves.toBe(false);
    expect(daemon.terminal.listed).toBe(true);

    daemon.killSucceeds = true;
    await expect(daemon.client.kill(terminal.id)).resolves.toBe(true);
    expect(daemon.terminal.listed).toBe(false);
    await expect(daemon.client.kill(terminal.id)).resolves.toBe(false);
    await expect(daemon.client.kill("unknown")).resolves.toBe(false);
    expect(daemon.killAttempts).toEqual([
      terminal.id,
      terminal.id,
      terminal.id,
      terminal.id,
      "unknown",
    ]);
    expect(daemon.killed).toEqual([terminal.id, terminal.id, "unknown"]);
  });
});
