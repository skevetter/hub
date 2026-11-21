import type { RunReplyRecord, RunReplyStore } from "../run-replies/store.js";
import type { DatabaseRuntime } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";

const projection = `reply.trigger_run_id as "runId", reply.organization_id as "organizationId",
  reply.comment_id as "commentId", reply.state, reply.length, reply.content_hash as hash,
  reply.binding_hash as "bindingHash", reply.attempted_at as "attemptedAt", reply.failure`;

export function postgresRunReplies(runtime: DatabaseRuntime, locks: Locks): RunReplyStore {
  return {
    async find({ organizationId, runId }) {
      const { rows } = await runtime.query<RunReplyRecord & Record<string, unknown>>(
        `select ${projection} from run_reply_deliveries reply
         where reply.organization_id = $1 and reply.trigger_run_id = $2`,
        [organizationId, runId],
      );
      return rows[0];
    },
    reserve(input) {
      return runtime.transaction(async (transaction) => {
        const { organizationId, runId, length, hash, bindingHash, perHour } = input;
        await locks.withTxLock(transaction, `run-reply:${organizationId}`);
        const { rows } = await transaction.query<{
          state: RunReplyRecord["state"];
          eligible: boolean;
        }>(
          `select reply.state, run.status = 'succeeded' and run.payload_expiry_state is null as eligible
           from run_reply_deliveries reply join trigger_runs run on run.id = reply.trigger_run_id
           where reply.organization_id = $1 and reply.trigger_run_id = $2
           for update of reply for share of run`,
          [organizationId, runId],
        );
        const row = rows[0];
        if (row === undefined || !row.eligible) return "run_unavailable";
        if (row.state !== "pending") return "already_handled";
        const recent = await transaction.query<{ count: number }>(
          `select count(*)::integer as count from run_reply_deliveries
           where organization_id = $1 and attempted_at > clock_timestamp() - interval '1 hour'`,
          [organizationId],
        );
        if (recent.rows[0]!.count >= perHour) {
          await transaction.query(
            `update run_reply_deliveries set state = 'refused', failure = 'rate_limited'
             where trigger_run_id = $1`,
            [runId],
          );
          return "rate_limited";
        }
        await transaction.query(
          `update run_reply_deliveries
           set state = 'sending', length = $2, content_hash = $3, binding_hash = $4,
               attempted_at = clock_timestamp()
           where trigger_run_id = $1`,
          [runId, length, hash, bindingHash],
        );
        return "reserved";
      });
    },
    async finish({ organizationId, runId, from, failure }) {
      const { rowCount } = await runtime.query(
        `update run_reply_deliveries set state = $4, failure = $5
         where organization_id = $1 and trigger_run_id = $2 and state = $3`,
        [organizationId, runId, from, failure === null ? "sent" : "refused", failure],
      );
      return rowCount === 1;
    },
    async recoverable(cutoff) {
      const { rows } = await runtime.query<RunReplyRecord & Record<string, unknown>>(
        `select ${projection}
         from run_reply_deliveries reply join trigger_runs run on run.id = reply.trigger_run_id
         where (reply.state = 'sending' and reply.attempted_at <= $1)
           or (reply.state = 'pending' and run.completed_at <= $1)
         order by coalesce(reply.attempted_at, run.completed_at), reply.trigger_run_id limit 50`,
        [cutoff],
      );
      return rows;
    },
  };
}
