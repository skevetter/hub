import { expect, test } from "vitest";
import { DaemonResponseLostError } from "../protocol.js";
import { FakeTerminalDaemon } from "../test-utils/fake-terminal-daemon.js";
import { DaemonTerminalError, DaemonTerminals } from "./index.js";

const options = {
  cwd: "/work",
  name: "hub-script-x",
  command: "/bin/sh",
  args: ["-c", "true"],
  size: { rows: 50, cols: 240 },
};

test("create sends the terminal request without a workspace or environment", async () => {
  const daemon = new FakeTerminalDaemon();
  const terminal = await daemon.client.create(options);
  expect(terminal).toMatchObject({ id: "terminal-1", workspaceId: "ws-1" });
  const [request] = daemon.requests;
  expect(request).toEqual({
    type: "create_terminal_request",
    requestId: "request-1",
    cwd: "/work",
    name: "hub-script-x",
    command: "/bin/sh",
    args: ["-c", "true"],
    size: { rows: 50, cols: 240 },
  });
  expect(request).not.toHaveProperty("workspaceId");
  expect(request).not.toHaveProperty("env");
});

test("capture asks for stripped lines counted from the end", async () => {
  const daemon = new FakeTerminalDaemon();
  await daemon.client.create(options);
  daemon.print("one\ntwo");
  expect(await daemon.client.capture("terminal-1", -400)).toEqual({
    lines: ["one", "two"],
    totalLines: 2,
  });
  expect(daemon.requests.at(-1)).toMatchObject({
    type: "capture_terminal_request",
    terminalId: "terminal-1",
    start: -400,
    stripAnsi: true,
  });
});

test("a refusal with access_denied becomes a permission error", async () => {
  const daemon = new FakeTerminalDaemon();
  daemon.denied.add("kill_terminal_request");
  await expect(daemon.client.kill("terminal-1")).rejects.toMatchObject({
    name: "DaemonTerminalError",
    code: "permission_denied",
  });
});

test("a create error that names the workspace is a missing workspace", async () => {
  const daemon = new FakeTerminalDaemon();
  daemon.createError = "workspaceId is required";
  await expect(daemon.client.create(options)).rejects.toMatchObject({ code: "no_workspace" });
});

test("frames that answer nothing this client asked are ignored", () => {
  const terminals = new DaemonTerminals(() => undefined);
  expect(
    terminals.receive({
      type: "session",
      message: { type: "capture_terminal_response", payload: { requestId: "x", lines: [] } },
    }),
  ).toBe(false);
  expect(terminals.receive({ type: "other" })).toBe(false);
});

test("closing the connection rejects waiting requests as lost", async () => {
  const daemon = new FakeTerminalDaemon();
  daemon.silent.add("kill_terminal_request");
  const pending = daemon.client.kill("terminal-1");
  daemon.client.close();
  await expect(pending).rejects.toBeInstanceOf(DaemonResponseLostError);
});

test("an unanswered request is reported as a lost response", async () => {
  const daemon = new FakeTerminalDaemon();
  daemon.silent.add("create_terminal_request");
  await expect(daemon.client.create(options, 5)).rejects.toBeInstanceOf(DaemonResponseLostError);
});

test("the error type carries its code", () => {
  expect(new DaemonTerminalError("request_failed", "x").code).toBe("request_failed");
});
