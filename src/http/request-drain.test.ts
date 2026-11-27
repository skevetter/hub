import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, it } from "vitest";
import { HttpRequestDrain } from "./request-drain.js";

function response(socket: Socket = new Socket()): ServerResponse {
  return new ServerResponse(new IncomingMessage(socket));
}

async function settled(promise: Promise<void>): Promise<boolean> {
  const turn = new Promise<boolean>((resolve) => setImmediate(() => resolve(false)));
  return Promise.race([promise.then(() => true), turn]);
}

describe("HttpRequestDrain", () => {
  it("resolves at once when nothing is in flight", async () => {
    const drain = new HttpRequestDrain();
    assert.equal(await settled(drain.begin()), true);
  });

  it("waits for a queued 503 to finish after the admitted response completes", async () => {
    const drain = new HttpRequestDrain();
    const admitted = response();
    const late = response();
    assert.equal(drain.admit(admitted), true);
    const drained = drain.begin();
    assert.equal(drain.admit(late), false);
    assert.equal(late.statusCode, 503);
    assert.equal(late.getHeader("connection"), "close");
    drain.complete(admitted);
    admitted.emit("finish");
    assert.equal(await settled(drained), false);
    late.emit("finish");
    assert.equal(await settled(drained), true);
  });

  it("stops waiting for a queued 503 when its connection closes", async () => {
    const drain = new HttpRequestDrain();
    const admitted = response();
    const late = response();
    drain.admit(admitted);
    const drained = drain.begin();
    drain.admit(late);
    drain.complete(admitted);
    admitted.emit("finish");
    assert.equal(await settled(drained), false);
    late.emit("close");
    assert.equal(await settled(drained), true);
  });

  it("stops waiting for a queued 503 when its socket closes without a response event", async () => {
    const drain = new HttpRequestDrain();
    const admitted = response();
    const late = response();
    drain.admit(admitted);
    const drained = drain.begin();
    drain.admit(late);
    drain.complete(admitted);
    admitted.emit("finish");
    assert.equal(await settled(drained), false);
    late.req.socket.emit("close");
    assert.equal(await settled(drained), true);
  });

  it("uses one socket listener however many 503s are queued on it", async () => {
    const drain = new HttpRequestDrain();
    const socket = new Socket();
    const admitted = response(socket);
    drain.admit(admitted);
    const drained = drain.begin();
    for (let index = 0; index < 12; index++) drain.admit(response(socket));
    assert.equal(socket.listenerCount("close"), 1);
    drain.complete(admitted);
    admitted.emit("finish");
    assert.equal(await settled(drained), false);
    socket.emit("close");
    assert.equal(await settled(drained), true);
  });

  it("expires the drain when a queued 503 never finishes", async () => {
    const drain = new HttpRequestDrain();
    const admitted = response();
    const stalled = response();
    drain.admit(admitted);
    const drained = drain.begin();
    drain.admit(stalled);
    drain.complete(admitted);
    admitted.emit("finish");
    assert.equal(await settled(drained), false);
    drain.expire();
    assert.equal(await settled(drained), true);
  });

  it("expires the drain when an admitted response never finishes", async () => {
    const drain = new HttpRequestDrain();
    drain.admit(response());
    const drained = drain.begin();
    drain.admit(response());
    assert.equal(await settled(drained), false);
    drain.expire();
    assert.equal(await settled(drained), true);
  });

  it("does not count a rejected response as an active request", () => {
    const drain = new HttpRequestDrain();
    void drain.begin();
    drain.admit(response());
    assert.equal(drain.activeRequests, 0);
  });
});
