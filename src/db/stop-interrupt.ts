import { z } from "zod";
import type { QueryHandle } from "./runtime/index.js";

export const stopInterruptStateSchema = z.object({
  approvedPeerIds: z.array(z.string()),
  target: z
    .object({
      agentId: z.string(),
      attachmentFingerprint: z.string(),
      peerIds: z.array(z.string()),
    })
    .optional(),
  settledPeerIds: z.array(z.string()).optional(),
});

export type StopInterruptState = z.infer<typeof stopInterruptStateSchema>;

export interface StopInterruptStore {
  claim(
    id: string,
    token: string,
    generation: string | null,
  ): Promise<{ state: StopInterruptState | null } | undefined>;
  save(id: string, token: string, state: StopInterruptState): Promise<boolean>;
  complete(id: string, token: string): Promise<void>;
  release(id: string, token: string): Promise<void>;
}

export const STOP_INTERRUPT_LEASE_MS = 120_000;
const acknowledgements = "coalesce(hub_action_acknowledgements, '{}'::jsonb)";
const claim = `${acknowledgements}->'stop_interrupt_claim'`;
const pending = "hub_action = 'interrupt' and hub_action_completed_at is null";
const lease = "clock_timestamp() + interval '2 minutes'";
const owns = `${claim}->>'token' = $2`;
const live = `(${claim}->>'until')::timestamptz > clock_timestamp()`;
const claimValue = `jsonb_build_object('token', $2::text, 'until', ${lease})`;

export function postgresStopInterrupts(database: QueryHandle): StopInterruptStore {
  return {
    async claim(id, token, generation) {
      const result = await database.query<{ state: unknown }>(
        `update agent_executions
         set hub_action_acknowledgements = jsonb_set(
           jsonb_set(${acknowledgements}, '{stop_interrupt_claim}', ${claimValue}),
           '{stop_interrupt_generation}', to_jsonb($2::text))
         where id = $1 and ${pending} and result->>'status' = 'canceled'
           and (${acknowledgements}->>'stop_interrupt_generation') is not distinct from $3::text
           and (${claim} is null or not (${live}))
         returning hub_action_acknowledgements->'stop_interrupt' as state`,
        [id, token, generation],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return { state: row.state == null ? null : stopInterruptStateSchema.parse(row.state) };
    },
    async save(id, token, state) {
      const result = await database.query(
        `update agent_executions
         set hub_action_acknowledgements = jsonb_set(
           jsonb_set(${acknowledgements}, '{stop_interrupt}', $3::jsonb),
           '{stop_interrupt_claim}', ${claimValue})
         where id = $1 and ${pending} and ${owns} and ${live}`,
        [id, token, JSON.stringify(state)],
      );
      return result.rowCount === 1;
    },
    async complete(id, token) {
      await database.query(
        `update agent_executions
         set hub_action_completed_at = clock_timestamp(),
             hub_action_acknowledgements = ${acknowledgements} - 'stop_interrupt_claim'
         where id = $1 and ${pending} and ${owns}`,
        [id, token],
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
  };
}
