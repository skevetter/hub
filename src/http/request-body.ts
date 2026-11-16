import { reportFailure } from "../failures/index.js";

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (Number.isSafeInteger(bytes) && bytes > maxBytes) {
      if (request.body !== null) cancelBody(request.body);
      return new Response("Payload Too Large", { status: 413 });
    }
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        cancelBody(reader);
        return new Response("Payload Too Large", { status: 413 });
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    reader.releaseLock();
  }
}

function cancelBody(
  body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
): void {
  void body.cancel().catch((error: unknown) => {
    reportFailure(error, { operation: "http.request.cancel", component: "http" });
  });
}
