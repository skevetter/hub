/** A request was in flight when its daemon went away. Nothing the author wrote caused it. */
export class DaemonDisconnectedError extends Error {
  readonly code = "upstreamUnavailable";

  constructor() {
    super("daemon disconnected");
    this.name = "DaemonDisconnectedError";
  }
}
