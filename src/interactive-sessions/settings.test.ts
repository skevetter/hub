import { expect, test } from "vitest";
import { readInteractiveSessionSettings } from "./settings.js";

test("interactive sessions default off with bounded daemon and queue limits", () => {
  expect(readInteractiveSessionSettings({})).toEqual({
    enabled: false,
    maxActivePerDaemon: 4,
    maxQueued: 20,
    maxMessagesPerMinute: 10,
  });
  expect(
    readInteractiveSessionSettings({
      PASEO_HUB_INTERACTIVE_SESSIONS: "true",
      PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON: "50",
      PASEO_HUB_SESSION_MAX_QUEUED: "100",
      PASEO_HUB_SESSION_MAX_MESSAGES_PER_MINUTE: "40",
    }),
  ).toEqual({ enabled: true, maxActivePerDaemon: 50, maxQueued: 100, maxMessagesPerMinute: 40 });
});

test.each([
  ["PASEO_HUB_INTERACTIVE_SESSIONS", "yes"],
  ["PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON", "0"],
  ["PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON", "51"],
  ["PASEO_HUB_SESSION_MAX_QUEUED", "1.5"],
  ["PASEO_HUB_SESSION_MAX_QUEUED", "101"],
])("rejects invalid %s value %s", (key, value) => {
  expect(() => readInteractiveSessionSettings({ [key]: value })).toThrow(key);
});
