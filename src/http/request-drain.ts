import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";

export class HttpRequestDrain {
  private stopping = false;
  private readonly active = new Set<ServerResponse>();
  // A 503 queued behind an admitted response on the same connection is still being written.
  // Draining must wait for it, or closing idle connections cuts it off.
  private readonly rejected = new Set<ServerResponse>();
  private readonly socketReleases = new WeakMap<Socket, Set<() => void>>();
  private readonly completion = Promise.withResolvers<void>();

  get activeRequests(): number {
    return this.active.size;
  }

  admit(response: ServerResponse): boolean {
    if (this.stopping) {
      this.unavailable(response);
      return false;
    }
    this.active.add(response);
    return true;
  }

  complete(response: ServerResponse): void {
    this.release(response, this.active);
  }

  acceptsUpgrades(): boolean {
    return !this.stopping;
  }

  begin(): Promise<void> {
    this.stopping = true;
    this.resolveWhenIdle();
    return this.completion.promise;
  }

  expire(): ReadonlySet<Socket> {
    const flushing = new Set<Socket>();
    for (const response of this.active) {
      if (response.headersSent || response.destroyed || response.writableEnded) continue;
      const socket = response.socket;
      if (socket !== null) {
        flushing.add(socket);
        response.once("finish", () => socket.destroy());
      }
      this.unavailable(response);
    }
    this.completion.resolve();
    return flushing;
  }

  // A response queued behind another on the same connection gets neither "finish" nor "close"
  // if the connection ends first, so the socket closing releases it too.
  private release(response: ServerResponse, tracked: Set<ServerResponse>): void {
    const socket = response.req.socket;
    let unwatch = () => {};
    const finish = () => {
      response.off("finish", finish);
      response.off("close", finish);
      unwatch();
      tracked.delete(response);
      this.resolveWhenIdle();
    };
    if (response.writableFinished || response.destroyed || socket.destroyed) finish();
    else {
      response.once("finish", finish);
      response.once("close", finish);
      unwatch = this.watchSocket(socket, finish);
    }
  }

  // One close listener per socket, however many responses are queued on it.
  private watchSocket(socket: Socket, release: () => void): () => void {
    let releases = this.socketReleases.get(socket);
    if (releases === undefined) {
      const pending = new Set<() => void>();
      releases = pending;
      this.socketReleases.set(socket, pending);
      socket.once("close", () => {
        for (const entry of pending) entry();
      });
    }
    const entries = releases;
    entries.add(release);
    return () => entries.delete(release);
  }

  private resolveWhenIdle(): void {
    if (this.stopping && this.active.size === 0 && this.rejected.size === 0) {
      this.completion.resolve();
    }
  }

  private unavailable(response: ServerResponse): void {
    response.statusCode = 503;
    response.setHeader("retry-after", "1");
    response.setHeader("connection", "close");
    response.end("Server is shutting down");
    this.rejected.add(response);
    this.release(response, this.rejected);
  }
}
