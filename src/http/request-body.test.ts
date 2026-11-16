import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readBoundedRequestBody } from "./request-body.js";

describe("bounded request body cancellation", () => {
  for (const declaredLength of [false, true]) {
    it(`returns 413 without awaiting ${declaredLength ? "declared" : "streamed"} overflow cancellation`, async () => {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(1025));
          },
          cancel() {
            cancellations += 1;
            return Promise.withResolvers<void>().promise;
          },
        },
        { highWaterMark: 0 },
      );
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        body,
        duplex: "half",
        ...(declaredLength ? { headers: { "content-length": "1025" } } : {}),
      };
      const request = new Request("http://hub.test/body", init);
      const response = await readBoundedRequestBody(request, 1024);
      assert.ok(response instanceof Response);
      assert.equal(response.status, 413);
      assert.equal(await response.text(), "Payload Too Large");
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
    }, 1000);
  }

  it("releases the reader after reading a bounded body", async () => {
    const request = new Request("http://hub.test/body", { method: "POST", body: "healthy" });
    const body = await readBoundedRequestBody(request, 1024);
    assert.ok(body instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(body), "healthy");
    assert.equal(request.body?.locked, false);
  });
});
