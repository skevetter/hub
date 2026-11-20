import { z } from "zod";
import type { TranscriptItem } from "../types.js";

const position = z.number().int().nonnegative();
const timelinePosition = z.object({ seq: position, at: z.string(), turnId: z.string().optional() });
const agent = z
  .discriminatedUnion("kind", [
    timelinePosition.extend({
      kind: z.literal("assistant"),
      text: z.string(),
      truncated: z.boolean(),
      chunkOffset: position.optional(),
      chunkStart: position.optional(),
    }),
    timelinePosition.extend({
      kind: z.literal("tool"),
      name: z.string(),
      status: z.enum(["running", "completed", "failed", "canceled"]),
    }),
    timelinePosition.extend({ kind: z.literal("human"), commandId: z.string().nullable() }),
  ])
  .transform((item): TranscriptItem => {
    if (item.kind === "human") return item;
    const { turnId, ...entry } = item;
    const turn = turnId === undefined ? {} : { turnId };
    if (entry.kind === "tool") return { ...entry, ...turn };
    const { chunkOffset, chunkStart, ...assistant } = entry;
    return {
      ...assistant,
      ...turn,
      ...(chunkOffset === undefined ? {} : { chunkOffset }),
      ...(chunkStart === undefined ? {} : { chunkStart }),
    };
  });
const commandStatus = z.enum([
  "pending",
  "queued",
  "dispatching",
  "delivered",
  "unknown",
  "superseded",
  "failed",
  "done",
]);
const message = z.object({
  commandId: z.string(),
  ordinal: position,
  authorName: z.string(),
  delivery: z.enum(["steer", "queue"]),
  status: commandStatus,
  text: z.string().nullable(),
  expired: z.boolean(),
  retryable: z.boolean(),
  createdAt: z.string(),
});

export const sessionEvents = {
  agent,
  message,
  delivery: z.object({
    commandId: z.string(),
    status: commandStatus,
    failureCode: z.string().nullable(),
  }),
  state: z.object({
    state: z.enum([
      "starting",
      "running",
      "idle",
      "waiting_permission",
      "stopping",
      "failed",
      "closed",
    ]),
    stateReason: z
      .enum([
        "stopped_by_person",
        "launch_failed",
        "agent_missing",
        "daemon_revoked",
        "closed_by_person",
        "stop_unconfirmed",
      ])
      .nullable(),
    generation: z.number().int().positive(),
    turn: position,
  }),
  participants: z.object({
    participants: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        role: z.enum(["controller", "viewer"]),
      }),
    ),
    capabilities: z.object({
      send: z.boolean(),
      stop: z.boolean(),
      close: z.boolean(),
      replaceAgent: z.boolean(),
      manageParticipants: z.boolean(),
    }),
  }),
  connection: z.object({ daemon: z.enum(["online", "offline"]) }),
  gap: z.object({ reason: z.enum(["daemon_disconnected", "epoch_changed", "behind"]) }),
  shutdown: z.object({ reconnectMs: position }),
  error: z.object({ code: z.enum(["slow_consumer", "reauth", "max_age"]) }),
};
