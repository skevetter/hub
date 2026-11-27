import { describe, expect, it } from "vitest";
import { readBoundedRequestBody } from "./request-body.js";

const headers = [undefined, "0", "2", "0003", "6", "-1", "x", "9007199254740993"];
const chunks = ["", "x", "abc", "abcd", "abcdef", "\u{1f34e}"];

function requestFor(header: string | undefined, data: string | undefined) {
  let cancelled = 0;
  let offset = 0;
  const body =
    data === undefined
      ? undefined
      : new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const bytes = new TextEncoder().encode(data);
              if (offset >= bytes.length) controller.close();
              else controller.enqueue(bytes.subarray(offset, offset + 2));
              offset += 2;
            },
            cancel() {
              cancelled += 1;
            },
          },
          { highWaterMark: 0 },
        );
  const init = {
    method: "POST",
    duplex: "half",
    ...(header === undefined ? {} : { headers: { "content-length": header } }),
    ...(body === undefined ? {} : { body }),
  };
  return { request: new Request("http://hub.test/", init), cancelled: () => cancelled };
}

function exceedsLimit(header: string | undefined, data: string | undefined, maxBytes: number) {
  const declaredOverflow = ["2", "0003", "6"].includes(header ?? "") && Number(header) > maxBytes;
  const actualOverflow = data !== undefined && new TextEncoder().encode(data).length > maxBytes;
  return declaredOverflow || actualOverflow;
}

function testBody(header: string | undefined, data: string | undefined, maxBytes: number) {
  it(`handles length ${header}, body ${data}, and limit ${maxBytes}`, async () => {
    const fixture = requestFor(header, data);
    const value = await readBoundedRequestBody(fixture.request, maxBytes);
    const tooLarge = exceedsLimit(header, data, maxBytes);
    const result =
      value instanceof Response
        ? { status: value.status, text: await value.text() }
        : { status: 200, text: new TextDecoder().decode(value) };
    expect(result).toEqual(
      tooLarge ? { status: 413, text: "Payload Too Large" } : { status: 200, text: data ?? "" },
    );
    expect(fixture.cancelled()).toBe(tooLarge && data !== undefined ? 1 : 0);
    expect(fixture.request.body?.locked).toBe(data === undefined ? undefined : false);
  });
}

describe("bounded body decisions", () => {
  for (const header of headers) {
    for (const chunk of [undefined, ...chunks]) {
      for (const limit of [0, 3, 6]) testBody(header, chunk, limit);
    }
  }

  it("releases the reader and preserves a failed stream's error", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("synthetic read failure"));
      },
    });
    const init = { method: "POST", body, duplex: "half" };
    const request = new Request("http://hub.test/", init);
    await expect(readBoundedRequestBody(request, 6)).rejects.toThrow("synthetic read failure");
    expect(request.body?.locked).toBe(false);
  });
});
