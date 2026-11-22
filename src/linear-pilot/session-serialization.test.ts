import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { createPilotSessionSerialization } from "./session-serialization.js";

const authority = {
  organizationId: "hub-org",
  workspaceId: "linear-workspace",
  applicationId: "linear-app",
  appUserId: "linear-app-user",
};
const origin = { nativeSessionId: "native-session" };

test("serializes two operations on the same native session", async () => {
  const withSession = createPilotSessionSerialization();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = withSession(authority, origin, async () => {
    order.push("first entered");
    entered.resolve();
    await release.promise;
    order.push("first exited");
  });
  await entered.promise;
  const second = withSession({ ...authority }, { ...origin }, async () => {
    order.push("second entered");
  });
  try {
    await setImmediate();
    expect(order).toEqual(["first entered"]);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
  expect(order).toEqual(["first entered", "first exited", "second entered"]);
});

test("lets unrelated native sessions make progress while one is held", async () => {
  const withSession = createPilotSessionSerialization();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const progressed: string[] = [];
  const first = withSession(authority, origin, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const others = [
    withSession(authority, { nativeSessionId: "other-session" }, async () => {
      progressed.push("other session");
    }),
    withSession({ ...authority, workspaceId: "other-workspace" }, origin, async () => {
      progressed.push("other workspace");
    }),
    withSession({ ...authority, applicationId: "other-app" }, origin, async () => {
      progressed.push("other application");
    }),
  ];
  try {
    await setImmediate();
    expect(progressed).toEqual(["other session", "other workspace", "other application"]);
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...others]);
  }
});

test("releases native-session serialization when the callback rejects", async () => {
  const withSession = createPilotSessionSerialization();
  const failure = new Error("synthetic native-session failure");
  const first = withSession(authority, origin, async () => {
    throw failure;
  });
  const second = withSession(authority, origin, async () => "entered");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The next callback remained locked")), 500);
  });
  try {
    await Promise.all([
      expect(first).rejects.toBe(failure),
      expect(Promise.race([second, deadline])).resolves.toBe("entered"),
    ]);
  } finally {
    clearTimeout(timer);
  }
}, 1_000);
