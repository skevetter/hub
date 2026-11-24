import { describe, expect, it } from "vitest";
import { confirmOnce } from "./outcome-toast.js";

function shown() {
  const messages: string[] = [];
  return { messages, show: (message: string) => messages.push(message) };
}

describe("confirmOnce", () => {
  it("confirms an outcome once, however often it is offered again", () => {
    const emitted = { current: undefined as unknown };
    const { messages, show } = shown();
    const outcome = {};
    confirmOnce(emitted, { message: "GitHub disconnected.", outcome }, show);
    confirmOnce(emitted, { message: "GitHub disconnected.", outcome }, show);
    expect(messages).toEqual(["GitHub disconnected."]);
  });

  it("stays quiet when the same outcome is reworded after a refresh", () => {
    const emitted = { current: undefined as unknown };
    const { messages, show } = shown();
    const outcome = {};
    confirmOnce(emitted, { message: "acme-inc disconnected.", outcome }, show);
    confirmOnce(emitted, { message: "GitHub disconnected.", outcome }, show);
    expect(messages).toEqual(["acme-inc disconnected."]);
  });

  it("confirms two separate actions that read the same", () => {
    const emitted = { current: undefined as unknown };
    const { messages, show } = shown();
    confirmOnce(emitted, { message: "Slack disconnected.", outcome: {} }, show);
    confirmOnce(emitted, { message: "Slack disconnected.", outcome: {} }, show);
    expect(messages).toEqual(["Slack disconnected.", "Slack disconnected."]);
  });

  it("says nothing without a message or an outcome", () => {
    const emitted = { current: undefined as unknown };
    const { messages, show } = shown();
    confirmOnce(emitted, { outcome: {} }, show);
    confirmOnce(emitted, { message: "Connected." }, show);
    expect(messages).toEqual([]);
    expect(emitted.current).toBeUndefined();
  });
});
