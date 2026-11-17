import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  CliAuthorizationPollSchema,
  CliAuthorizationSchema,
  PollCliAuthorizationRequestSchema,
  ProblemSchema,
  StartCliAuthorizationRequestSchema,
  WebhookPathSchema,
  WebhookHeadersSchema,
  WebhookJsonBodySchema,
  WebhookTextBodySchema,
} from "./contracts.js";
import { publicOperationManifest } from "./operation-manifest.js";

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Paseo organization credential",
  description:
    "An organization API key or durable CLI login credential. Each operation requires the scope shown on the operation.",
});

registry.registerPath({
  method: "post",
  path: "/api/v1/cli-authorizations",
  operationId: "startCliAuthorization",
  summary: "Start CLI login",
  description: "Starts an anonymous, expiring browser authorization for the Paseo CLI.",
  tags: ["CLI login"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: StartCliAuthorizationRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "The CLI login request was created.",
      content: { "application/json": { schema: CliAuthorizationSchema } },
    },
    429: { description: "Too many active authorization requests." },
    503: { description: "Durable storage is unavailable." },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/cli-authorizations/poll",
  operationId: "pollCliAuthorization",
  summary: "Poll CLI login",
  description:
    "Polls an anonymous CLI login request. An approved credential is disclosed exactly once.",
  tags: ["CLI login"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PollCliAuthorizationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The current authorization state.",
      content: { "application/json": { schema: CliAuthorizationPollSchema } },
    },
    503: { description: "Durable storage is unavailable." },
  },
});

registry.registerComponent("securitySchemes", "browserSession", {
  type: "apiKey",
  in: "cookie",
  name: "__Secure-better-auth.session_token",
  description: "Same-origin browser session. Local HTTP uses better-auth.session_token.",
});

const runStreamResponses: Parameters<typeof registry.registerPath>[0]["responses"] = {
  200: {
    description:
      "A pull-based event stream. retry: 5000 and : stream open precede status. Stored rows use id: seq, event: kind and one JSON data line. Heartbeats are : ping. Control events status, end, shutdown, reconnect and error never have ids.",
    content: { "text/event-stream": { schema: z.string() } },
  },
};
for (const [status, description] of [
  [400, "Invalid cursor."],
  [401, "Missing or invalid credential or session."],
  [403, "Missing runs:read scope."],
  [404, "Unknown, foreign or rejected run, or disabled route."],
  [410, "The authorized run timeline has expired."],
  [429, "An open stream limit was reached. Retry after 30 seconds."],
  [503, "Hub is stopping or storage is unavailable. Shutdown retry is 5 seconds."],
] as const) {
  runStreamResponses[status] = {
    description,
    headers: {
      ...(status === 401
        ? { "WWW-Authenticate": { schema: { type: "string", example: "Bearer" } } }
        : {}),
      ...(status === 429 || status === 503
        ? { "Retry-After": { schema: { type: "integer" } } }
        : {}),
    },
    content: { "application/problem+json": { schema: ProblemSchema } },
  };
}

registry.registerPath({
  method: "get",
  path: "/api/v1/runs/{id}/events",
  operationId: "streamRunEvents",
  summary: "Stream a run timeline",
  description:
    "Read stored timeline rows with runs:read or an organization member session. Resume after the last event id. End is sent only after terminal reconciliation and the seal.",
  tags: ["Runs"],
  security: [{ bearerAuth: [] }, { browserSession: [] }],
  "x-required-scopes": ["runs:read"],
  request: {
    params: z.object({ id: z.string().uuid() }),
    headers: z.object({
      "Last-Event-ID": z
        .string()
        .regex(/^[0-9]+$/u)
        .optional(),
    }),
    query: z.object({
      after: z
        .string()
        .regex(/^[0-9]+$/u)
        .optional()
        .describe("Non-negative safe integer cursor. Overrides Last-Event-ID."),
      organization: z
        .string()
        .optional()
        .describe("Organization slug. Required with a browser session."),
    }),
  },
  responses: runStreamResponses,
});

const requestIdResponseHeader = {
  "X-Request-ID": {
    description: "The accepted or generated request identifier.",
    schema: { type: "string" as const },
  },
};

for (const definition of publicOperationManifest) {
  const responses = Object.fromEntries(
    Object.entries(definition.responses).map(([status, description]) => [
      status,
      Number(status) === definition.successStatus || (definition.webhook && Number(status) === 200)
        ? {
            description,
            headers: requestIdResponseHeader,
            content: { "application/json": { schema: definition.successSchema } },
          }
        : {
            description,
            headers: {
              ...requestIdResponseHeader,
              ...(Number(status) === 401
                ? {
                    "WWW-Authenticate": {
                      description: "Bearer authentication challenge.",
                      schema: { type: "string" as const, example: "Bearer" },
                    },
                  }
                : {}),
              ...(Number(status) === 429 || Number(status) === 503
                ? {
                    "Retry-After": {
                      description: "Seconds to wait before retrying.",
                      schema: { type: "integer" as const, minimum: 1, example: 30 },
                    },
                  }
                : {}),
              ...(Number(status) === 405
                ? {
                    Allow: {
                      description: "Allowed HTTP method.",
                      schema: { type: "string" as const, example: "POST" },
                    },
                  }
                : {}),
            },
            content: { "application/problem+json": { schema: ProblemSchema } },
          },
    ]),
  );
  let request: Parameters<typeof registry.registerPath>[0]["request"];
  if (definition.webhook) {
    request = {
      params: WebhookPathSchema,
      headers: WebhookHeadersSchema,
      body: {
        required: true,
        content: {
          "application/json": { schema: WebhookJsonBodySchema },
          "text/plain": { schema: WebhookTextBodySchema },
        },
      },
    };
  } else if (definition.requestSchema !== undefined) {
    request = {
      body: {
        required: true,
        content: { "application/json": { schema: definition.requestSchema } },
      },
    };
  }
  registry.registerPath({
    method: definition.method,
    path: definition.path,
    operationId: definition.id,
    summary: definition.summary,
    description: definition.description,
    tags: [definition.tag],
    security: [{ bearerAuth: [] }],
    ...(request === undefined ? {} : { request }),
    responses,
    "x-required-scopes": [definition.scope],
  });
}

export const publicOpenApiDocument = new OpenApiGeneratorV31(registry.definitions).generateDocument(
  {
    openapi: "3.1.0",
    info: {
      title: "Paseo Hub Public API",
      version: "1.0.0",
      description:
        "Log in the CLI, list projects, validate and install configuration, dispatch manual runs, and enroll Paseo daemons.",
    },
    servers: [{ url: "/", description: "This Hub instance" }],
    tags: [
      { name: "CLI login" },
      { name: "Triggers" },
      { name: "Webhooks" },
      { name: "Projects" },
      { name: "Configurations" },
      { name: "Runs" },
      { name: "Daemons" },
    ],
  },
);
