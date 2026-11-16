import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";

export class HttpRequestDrain {
  private stopping = false;
  private readonly active = new Set<ServerResponse>();
  private readonly completion = Promise.withResolvers<void>();

  admit(response: ServerResponse): boolean {
    if (this.stopping) {
      this.unavailable(response);
      return false;
    }
    this.active.add(response);
    return true;
  }

  complete(response: ServerResponse): void {
    const finish = () => {
      response.off("finish", finish);
      response.off("close", finish);
      this.active.delete(response);
      if (this.stopping && this.active.size === 0) this.completion.resolve();
    };
    if (response.writableFinished || response.destroyed) finish();
    else {
      response.once("finish", finish);
      response.once("close", finish);
    }
  }

  acceptsUpgrades(): boolean {
    return !this.stopping;
  }

  begin(): Promise<void> {
    this.stopping = true;
    if (this.active.size === 0) this.completion.resolve();
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

  private unavailable(response: ServerResponse): void {
    response.statusCode = 503;
    response.setHeader("retry-after", "1");
    response.setHeader("connection", "close");
    response.end("Server is shutting down");
  }
}
