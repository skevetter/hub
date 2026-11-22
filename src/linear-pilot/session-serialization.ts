import type { PilotAuthority, PilotNativeOrigin } from "./binding.js";

type Installation = Pick<
  PilotAuthority,
  "organizationId" | "workspaceId" | "applicationId" | "appUserId"
>;

export function createPilotSessionSerialization() {
  const tails = new Map<string, Promise<void>>();

  // The callback must not re-enter this key.
  return async function withSession<T>(
    authority: Installation,
    origin: Pick<PilotNativeOrigin, "nativeSessionId">,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([
      authority.organizationId,
      authority.workspaceId,
      authority.applicationId,
      authority.appUserId,
      origin.nativeSessionId,
    ]);
    const previous = tails.get(key);
    const { promise, resolve } = Promise.withResolvers<void>();
    tails.set(key, promise);
    await previous;
    try {
      return await run();
    } finally {
      resolve();
      if (tails.get(key) === promise) tails.delete(key);
    }
  };
}
