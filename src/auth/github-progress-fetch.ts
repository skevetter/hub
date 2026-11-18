const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_MS = 5000;

export const GITHUB_API_ORIGIN = "https://api.github.com";

export function githubProgressFetch(request: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== GITHUB_API_ORIGIN) throw new Error("Unexpected GitHub API origin");
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    try {
      const response = await request(input, { ...init, redirect: "manual" });
      if (response.redirected) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Unexpected GitHub redirect");
      }
      const body = await readBody(response, signal);
      const headers = new Headers();
      const retryAfter = response.headers.get("retry-after");
      if (
        retryAfter !== null &&
        (/^\d+$/u.test(retryAfter) || Number.isFinite(Date.parse(retryAfter)))
      )
        headers.set("retry-after", retryAfter);
      for (const name of ["x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = response.headers.get(name);
        if (value !== null && /^\d+$/u.test(value)) headers.set(name, value);
      }
      if (response.headers.has("x-github-sso")) headers.set("x-github-sso", "required");
      if (
        response.headers
          .get("x-oauth-scopes")
          ?.split(",")
          .some((scope) => scope.trim() === "repo" || scope.trim().startsWith("admin:"))
      )
        headers.set("x-oauth-scopes", "repo");
      // Octokit can copy upstream error bodies into exceptions. Keep only rejection evidence.
      if (response.status >= 300) {
        headers.set("content-type", "application/json");
        return new Response(JSON.stringify(errorEvidence(body, response.status)), {
          status: response.status,
          headers,
        });
      }
      const contentType = response.headers.get("content-type");
      if (contentType !== null) headers.set("content-type", contentType.split(";")[0]!);
      return new Response(body, { status: response.status, headers });
    } catch {
      throw new Error("GitHub progress request failed");
    }
  };
}

function errorEvidence(
  body: string | null,
  status: number,
): { rejected: boolean; partial: boolean } {
  if (body === null) return { rejected: false, partial: false };
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return { rejected: false, partial: false };
    const partial =
      ("status" in value && value.status !== status && value.status !== String(status)) ||
      Object.keys(value).some(
        (key) => !["message", "documentation_url", "status", "errors"].includes(key),
      );
    return {
      rejected:
        !partial && !("errors" in value) && "message" in value && typeof value.message === "string",
      partial,
    };
  } catch {
    return { rejected: false, partial: false };
  }
}

async function readBody(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const timeout = AbortSignal.timeout(MAX_BODY_MS);
  const bounded = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(new Error("GitHub progress response interrupted"));
  bounded.addEventListener("abort", abort, { once: true });
  try {
    bounded.throwIfAborted();
    return await Promise.race([readChunks(reader, performance.now() + MAX_BODY_MS), promise]);
  } finally {
    bounded.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number) {
  const decoder = new TextDecoder();
  let length = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (performance.now() >= deadline) throw new Error("GitHub progress response timed out");
    if (done) return body + decoder.decode();
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) throw new Error("GitHub progress response exceeds 1 MiB");
    body += decoder.decode(value, { stream: true });
  }
}
