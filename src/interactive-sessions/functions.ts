import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication, type ApplicationRuntime } from "../server/runtime.js";
import { sessionRefusal, type InteractiveSessionService, type SessionRefusal } from "./service.js";
import type { InteractiveSessionStream } from "./stream.js";

export type {
  CommandOutcome,
  HistoryPage,
  ParticipantOutcome,
  ProfileSaveOutcome,
  ProfileView,
  SessionListPage,
  SessionSnapshot,
} from "./service.js";

const slug = z.string().trim().min(1).max(100);
const id = z.uuid().transform((value) => value.toLowerCase());
const role = z.enum(["controller", "viewer"]);
const userId = z.string().min(1).max(100);
const message = z
  .string()
  .min(1)
  .max(16 * 1024);
const scope = z.object({ organizationSlug: slug });
const session = scope.extend({ sessionId: id });
const control = session.extend({ generation: z.number().int().positive(), idempotencyKey: id });

interface SessionRuntime {
  service: InteractiveSessionService;
  stream: InteractiveSessionStream;
}

export const getInteractiveSessionRuntime = createServerOnlyFn(async () => {
  // Application composition supplies the feature runtime when enabled.
  const application: ApplicationRuntime & { interactiveSessions?: SessionRuntime | null } =
    await getApplication();
  return application.interactiveSessions ?? null;
});

const respond = createServerOnlyFn(
  async <T>(
    operation: string,
    organizationSlug: string,
    run: (service: InteractiveSessionService, request: Request) => Promise<T>,
  ): Promise<Result<T | SessionRefusal<"not_found" | "invalid_request">>> => {
    try {
      const runtime = await getInteractiveSessionRuntime();
      if (runtime === null) return respondOk(sessionRefusal("not_found"));
      return respondOk(await run(runtime.service, getRequest()));
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "SessionReadError" &&
        (error.message === "not_found" || error.message === "invalid_request")
      )
        return respondOk(sessionRefusal(error.message));
      return respondWithFailure(
        error,
        { operation, component: "interactive-sessions", organizationSlug },
        { fallback: "The session request could not be completed." },
      );
    }
  },
);

export const listInteractiveSessions = createServerFn({ method: "GET" })
  .validator(
    scope.extend({ filter: z.enum(["active", "all"]), cursor: z.string().max(200).nullable() }),
  )
  .handler(({ data }) =>
    respond("interactiveSession.list", data.organizationSlug, (service, request) =>
      service.list(request, data),
    ),
  );

export const readInteractiveSession = createServerFn({ method: "GET" })
  .validator(session)
  .handler(({ data }) =>
    respond("interactiveSession.read", data.organizationSlug, (service, request) =>
      service.snapshot(request, data),
    ),
  );

export const readSessionHistory = createServerFn({ method: "GET" })
  .validator(
    session.extend({
      before: z
        .object({ epoch: z.string().min(1).max(200), seq: z.number().int().nonnegative() })
        .nullable(),
      limit: z.number().int().min(1).max(50),
    }),
  )
  .handler(({ data }) =>
    respond("interactiveSession.history", data.organizationSlug, (service, request) =>
      service.history(request, data),
    ),
  );

export const startInteractiveSession = createServerFn({ method: "POST" })
  .validator(
    scope.extend({
      profileId: id,
      profileVersion: z.number().int().positive(),
      message,
      participants: z.array(z.object({ userId, role })).max(20),
      idempotencyKey: id,
    }),
  )
  .handler(({ data }) =>
    respond("interactiveSession.start", data.organizationSlug, (service, request) =>
      service.command(request, { ...data, kind: "start" }),
    ),
  );

export const sendSessionMessage = createServerFn({ method: "POST" })
  .validator(control.extend({ message, delivery: z.enum(["steer", "queue"]) }))
  .handler(({ data }) =>
    respond("interactiveSession.send", data.organizationSlug, (service, request) =>
      service.command(request, { ...data, kind: "send" }),
    ),
  );

export const retrySessionMessage = createServerFn({ method: "POST" })
  .validator(control.extend({ commandId: id }))
  .handler(({ data }) =>
    respond("interactiveSession.retry", data.organizationSlug, (service, request) =>
      service.command(request, { ...data, kind: "retry" }),
    ),
  );

export const stopSession = createServerFn({ method: "POST" })
  .validator(control)
  .handler(({ data }) =>
    respond("interactiveSession.stop", data.organizationSlug, (service, request) =>
      service.command(request, { ...data, kind: "stop" }),
    ),
  );

export const closeSession = createServerFn({ method: "POST" })
  .validator(control)
  .handler(({ data }) =>
    respond("interactiveSession.close", data.organizationSlug, (service, request) =>
      service.command(request, { ...data, kind: "close" }),
    ),
  );

export const replaceSessionAgent = createServerFn({ method: "POST" })
  .validator(control)
  .handler(({ data }) =>
    respond("interactiveSession.replace", data.organizationSlug, (service, request) =>
      service.command(request, { ...data, kind: "replace" }),
    ),
  );

export const setSessionParticipant = createServerFn({ method: "POST" })
  .validator(session.extend({ userId, role: role.nullable() }))
  .handler(({ data }) =>
    respond("interactiveSession.participants", data.organizationSlug, (service, request) =>
      service.participants(request, data),
    ),
  );

export const listSessionProfiles = createServerFn({ method: "GET" })
  .validator(scope.extend({ manage: z.boolean().optional() }))
  .handler(({ data }) =>
    respond("interactiveSession.profiles", data.organizationSlug, (service, request) =>
      service.profiles(request, data.organizationSlug, data.manage),
    ),
  );

export const saveSessionProfile = createServerFn({ method: "POST" })
  .validator(
    scope.extend({
      id: id.nullable(),
      version: z.number().int().positive().nullable(),
      name: z.string().trim().min(1).max(80),
      daemonId: id,
      cwd: z.string().min(1).max(1024),
      worktree: z
        .object({ mode: z.literal("branch-off"), base: z.string().min(1).max(200).optional() })
        .nullable(),
      provider: z.string().min(1).max(64),
      model: z.string().max(200).nullable(),
      mode: z.string().max(64).nullable(),
      thinkingOptionId: z.string().max(64).nullable(),
      fullAccessAcknowledged: z.boolean(),
      status: z.enum(["active", "disabled"]),
    }),
  )
  .handler(({ data }) =>
    respond("interactiveSession.saveProfile", data.organizationSlug, (service, request) =>
      service.saveProfile(request, {
        ...data,
        worktree:
          data.worktree === null
            ? null
            : {
                mode: data.worktree.mode,
                ...(data.worktree.base === undefined ? {} : { base: data.worktree.base }),
              },
      }),
    ),
  );
