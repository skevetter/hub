import { randomUUID } from "node:crypto";
import { ProblemSchema } from "./contracts.js";

export function requestIdentifier(request: Pick<Request, "headers">): string {
  const value = request.headers.get("x-request-id");
  return value !== null && /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : randomUUID();
}

export function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
  headers?: Readonly<Record<string, string>>,
): Response {
  return Response.json(
    ProblemSchema.parse({
      type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
      title,
      status,
      detail,
      code,
      requestId,
      ...(issues === undefined ? {} : { issues }),
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": requestId,
        ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
        ...headers,
      },
    },
  );
}
