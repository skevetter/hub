import { z } from "zod";
import type { QueryHandle } from "./runtime/index.js";

const outcomes = z.enum(["confirmed", "delivery_unconfirmed", "target_gone"]);
const stopInterruptStateSchema = z.object({
  approvedPeerIds: z.array(z.string()),
  attemptId: z.string().optional(),
  requestedAt: z.string().optional(),
  startedAt: z.string().optional(),
  acknowledgedPeerIds: z.array(z.string()).optional(),
  outcome: outcomes.optional(),
  // Pending rows from the earlier delivery implementation could already have sent.
  target: z.unknown().optional(),
});

export type StopInterruptState = z.infer<typeof stopInterruptStateSchema>;
export type StopInterruptOutcome = z.infer<typeof outcomes>;

export interface StopInterruptStore {
  claim(
    id: string,
    token: string,
    generation: string | null,
  ): Promise<{ state: StopInterruptState | null; expired: boolean } | undefined>;
  start(id: string, token: string): Promise<boolean>;
  resetUnsent(id: string, token: string): Promise<void>;
  acknowledge(id: string, token: string, peers: string[]): Promise<boolean>;
  complete(id: string, token: string, outcome: StopInterruptOutcome): Promise<void>;
  release(id: string, token: string): Promise<void>;
  revoke(daemonId: string): Promise<void>;
}

export const STOP_INTERRUPT_LEASE_MS = 120_000;
export const STOP_INTERRUPT_MAX_AGE_MS = 86_400_000;
export const STOP_RECOVERY_BATCH_SIZE = 100;

const acknowledgements = "coalesce(hub_action_acknowledgements, '{}'::jsonb)";
const state = `${acknowledgements}->'stop_interrupt'`;
const claim = `${acknowledgements}->'stop_interrupt_claim'`;
const pending =
  "hub_action = 'interrupt' and hub_action_completed_at is null and result->>'status' = 'canceled'";
const lease = "clock_timestamp() + interval '2 minutes'";
const owns = `${claim}->>'token' = $2`;
const live = `(${claim}->>'until')::timestamptz > clock_timestamp()`;
const expired = `coalesce((${state}->>'requestedAt')::timestamptz, completed_at)
  <= clock_timestamp() - interval '24 hours'`;
const claimValue = `jsonb_build_object('token', $2::text, 'until', ${lease})`;

function withState(update: string) {
  return `jsonb_set(${acknowledgements}, '{stop_interrupt}', coalesce(${state}, '{}'::jsonb) ${update})`;
}

export function postgresStopInterrupts(database: QueryHandle): StopInterruptStore {
  return {
    async claim(id, token, generation) {
      const result = await database.query<{ state: unknown; expired: boolean }>(
        `update agent_executions
         set hub_action_acknowledgements = jsonb_set(jsonb_set(jsonb_set(
           ${acknowledgements}, '{stop_interrupt_claim}', ${claimValue}),
           '{stop_interrupt_generation}', to_jsonb($2::text)),
           '{stop_interrupt_checked_at}', to_jsonb(clock_timestamp()))
         where id = $1 and ${pending}
           and (${acknowledgements}->>'stop_interrupt_generation') is not distinct from $3::text
           and (${claim} is null or not (${live}))
         returning ${state} as state, coalesce(${expired}, false) as expired`,
        [id, token, generation],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        state: row.state == null ? null : stopInterruptStateSchema.parse(row.state),
        expired: row.expired,
      };
    },
    async start(id, token) {
      const result = await database.query(
        `update agent_executions
         set hub_action_acknowledgements = jsonb_set(
           ${withState("|| jsonb_build_object('startedAt', clock_timestamp())")},
           '{stop_interrupt_claim}', ${claimValue})
         where id = $1 and ${pending} and ${owns} and ${live} and not (${expired})
           and ${state}->>'startedAt' is null and ${state}->'target' is null`,
        [id, token],
      );
      return result.rowCount === 1;
    },
    async resetUnsent(id, token) {
      await database.query(
        `update agent_executions set hub_action_acknowledgements = ${withState("- 'startedAt'")}
         where id = $1 and ${pending} and ${owns}`,
        [id, token],
      );
    },
    async acknowledge(id, token, peers) {
      const result = await database.query(
        `update agent_executions set hub_action_acknowledgements =
           ${withState("|| jsonb_build_object('acknowledgedPeerIds', $3::jsonb)")}
         where id = $1 and ${pending} and ${owns}`,
        [id, token, JSON.stringify(peers)],
      );
      return result.rowCount === 1;
    },
    async complete(id, token, outcome) {
      await database.query(
        `update agent_executions
         set hub_action_completed_at = clock_timestamp(),
             hub_action_acknowledgements = ${withState("|| jsonb_build_object('outcome', $3::text)")} - 'stop_interrupt_claim'
         where id = $1 and ${pending} and ${owns}`,
        [id, token, outcome],
      );
    },
    async release(id, token) {
      await database.query(
        `update agent_executions
         set hub_action_acknowledgements = jsonb_set(
           ${acknowledgements} - 'stop_interrupt_claim',
           '{stop_interrupt_generation}', to_jsonb($2::text || ':released'))
         where id = $1 and ${owns}`,
        [id, token],
      );
    },
    async revoke(daemonId) {
      await database.query(
        `update agent_executions
         set hub_action_completed_at = clock_timestamp(),
             hub_action_acknowledgements = ${withState("|| jsonb_build_object('outcome', 'target_gone')")} - 'stop_interrupt_claim'
         where daemon_id = $1 and ${pending}`,
        [daemonId],
      );
    },
  };
}
