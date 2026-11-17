import { and, eq, gt } from "drizzle-orm";
import type { DatabaseRuntime, TransactionHandle } from "../db/runtime/index.js";
import { runProgressMessages } from "../db/schema.js";
import {
  isOrdinary,
  prepareTimelineData,
  timelineBudgetExceeded,
  timelineCallIdText,
  timelineStepId,
} from "./data.js";
import { timelineAccountingBatchId } from "./store.js";
import type {
  AppendRunTimelineEventInput,
  AppendRunTimelineEventResult,
  InsertRunProgressMessageInput,
  RunProgressLeaseInput,
  RunProgressMessage,
  RunTimelineEvent,
  RunTimelineState,
  UpdateRunProgressMessageInput,
} from "./store.js";

type Row<T> = T & Record<string, unknown>;
const STATE = `trigger_run_id as "triggerRunId", organization_id as "organizationId",
 event_count as "eventCount", byte_count as "byteCount", step_end_count as "stepEndCount",
 step_end_bytes as "stepEndBytes", step_rows_omitted as "stepRowsOmitted", dropped_count as "droppedCount",
 sealed_seq as "sealedSeq", sealed_at as "sealedAt", origin, expired_at as "expiredAt"`;
const EVENT = `trigger_run_id as "triggerRunId", organization_id as "organizationId", seq, kind, at,
 step_id as "stepId", data`;
const MESSAGE = `trigger_run_id as "triggerRunId", organization_id as "organizationId", provider, state,
 external_ref as "externalRef", version, lease_owner as "leaseOwner", lease_expires_at as "leaseExpiresAt",
 last_rendered_hash as "lastRenderedHash", last_edit_at as "lastEditAt", edit_count as "editCount",
 failed_edits as "failedEdits", final_failures as "finalFailures", retry_at as "retryAt",
 settle_at as "settleAt", repeat_final as "repeatFinal", visibility, visibility_checked_at as "visibilityCheckedAt", failure,
 compensation_requested_gen as "compensationRequestedGen", compensation_done_gen as "compensationDoneGen",
 compensation_not_before as "compensationNotBefore", created_at as "createdAt", updated_at as "updatedAt"`;

export class RunTimelineRepository {
  constructor(private readonly runtime: DatabaseRuntime) {}

  async recordRunTimelineDrops(
    organizationId: string,
    runId: string,
    count: number,
    at: Date,
    batchId: string,
  ) {
    if (!Number.isSafeInteger(count) || count <= 0)
      throw new RangeError("Invalid timeline drop count");
    batchId = timelineAccountingBatchId(batchId);
    return this.runtime.transaction(async (transaction) => {
      const run = await transaction.query(
        `select id from trigger_runs where id = $1 and organization_id = $2 and outcome = 'accepted' for key share`,
        [runId, organizationId],
      );
      if (run.rowCount === 0) return undefined;
      await transaction.query(
        `insert into run_timeline_state (trigger_run_id, organization_id, origin) values ($1, $2, 'captured') on conflict do nothing`,
        [runId, organizationId],
      );
      const state = (
        await transaction.query<Row<RunTimelineState> & { accountingBatchIds: string[] | null }>(
          `select ${STATE}, accounting_batch_ids as "accountingBatchIds" from run_timeline_state where trigger_run_id = $1 and organization_id = $2 for update`,
          [runId, organizationId],
        )
      ).rows[0]!;
      if (state.expiredAt !== null) return undefined;
      if (state.accountingBatchIds?.includes(batchId)) {
        const notice = (
          await transaction.query<{ seq: number }>(
            `select seq from run_timeline_events where trigger_run_id = $1 and kind = 'truncated' limit 1`,
            [runId],
          )
        ).rows[0];
        return notice === undefined
          ? { seq: state.eventCount, inserted: false }
          : { seq: state.eventCount, inserted: false, noticeSeq: notice.seq };
      }
      const batchIds = (state.accountingBatchIds ?? []).slice(-15);
      batchIds.push(batchId);
      await transaction.query(
        `update run_timeline_state set dropped_count = dropped_count + $2, accounting_batch_ids = $3::text[] where trigger_run_id = $1`,
        [runId, count, batchIds],
      );
      if (state.sealedSeq !== null) return { seq: state.eventCount, inserted: false };
      const notice = await transaction.query(
        `select 1 from run_timeline_events where trigger_run_id = $1 and kind = 'truncated'`,
        [runId],
      );
      if (notice.rowCount !== 0) return { seq: state.eventCount, inserted: false };
      const seq = state.eventCount + 1;
      await transaction.query(
        `insert into run_timeline_events (trigger_run_id, organization_id, seq, kind, at, step_id, data) values ($1, $2, $3, 'truncated', $4, '', $5::jsonb)`,
        [runId, organizationId, seq, at, JSON.stringify({ dropped: state.droppedCount + count })],
      );
      await transaction.query(
        `update run_timeline_state set event_count = $2 where trigger_run_id = $1`,
        [runId, seq],
      );
      return { seq, inserted: true };
    });
  }

  async appendRunTimelineEvent(
    input: AppendRunTimelineEventInput,
  ): Promise<AppendRunTimelineEventResult> {
    const maxEvents = input.maxEvents ?? 500;
    if (!Number.isInteger(maxEvents) || maxEvents < 50 || maxEvents > 5000)
      throw new RangeError("Invalid timeline event limit");
    const stepId = timelineStepId(input.stepId ?? "");
    const data = prepareTimelineData(input.kind, input.data);
    return this.runtime.transaction(async (transaction) => {
      const run = await transaction.query(
        `select id from trigger_runs where id = $1 and organization_id = $2 and outcome = 'accepted' for key share`,
        [input.triggerRunId, input.organizationId],
      );
      if (run.rowCount === 0) return undefined;
      await transaction.query(
        `insert into run_timeline_state (trigger_run_id, organization_id, origin) values ($1, $2, $3) on conflict do nothing`,
        [input.triggerRunId, input.organizationId, input.origin],
      );
      const state = (
        await transaction.query<Row<RunTimelineState>>(
          `select ${STATE} from run_timeline_state where trigger_run_id = $1 and organization_id = $2 for update`,
          [input.triggerRunId, input.organizationId],
        )
      ).rows[0]!;
      if (state.expiredAt !== null) return { reason: "expired" };
      if (state.sealedSeq !== null) {
        if (isOrdinary(input.kind))
          await transaction.query(
            `update run_timeline_state set dropped_count = dropped_count + 1 where trigger_run_id = $1`,
            [input.triggerRunId],
          );
        return { reason: "sealed" };
      }
      const duplicate = await transaction.query<{ seq: number }>(
        `select seq from run_timeline_events where trigger_run_id = $1 and kind = $2 and
        (($2 in ('run_started', 'step_started', 'step_finished', 'run_finished', 'agent_started') and step_id = $3)
         or ($2 in ('tool_started', 'tool_finished') and step_id = $3 and data->>'callId' = $4)
         or $2 = 'truncated') limit 1`,
        [input.triggerRunId, input.kind, stepId, timelineCallIdText(data)],
      );
      if (duplicate.rows[0] !== undefined) return { seq: duplicate.rows[0].seq, inserted: false };
      const notice =
        (
          await transaction.query(
            `select 1 from run_timeline_events where trigger_run_id = $1 and kind = 'truncated' limit 1`,
            [input.triggerRunId],
          )
        ).rowCount !== 0;
      if (timelineBudgetExceeded(state, input.kind, 0, maxEvents, notice)) {
        await this.drop(transaction, input, state, notice);
        return { reason: "cap" };
      }
      if (input.kind === "run_finished") {
        await this.refreshOmitted(transaction, input.triggerRunId, state);
        data["stepRowsOmitted"] = state.stepRowsOmitted;
      }
      const prepared = prepareTimelineData(input.kind, data);
      await transaction.query("savepoint timeline_append");
      const inserted = await transaction.query<Row<RunTimelineEvent> & { bytes: number }>(
        `insert into run_timeline_events (trigger_run_id, organization_id, seq, kind, at, step_id, data) values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict do nothing returning ${EVENT}, octet_length(data::text) as bytes`,
        [
          input.triggerRunId,
          input.organizationId,
          state.eventCount + 1,
          input.kind,
          input.at,
          stepId,
          JSON.stringify(prepared),
        ],
      );
      const event = inserted.rows[0];
      if (event === undefined) return { seq: state.eventCount, inserted: false };
      if (timelineBudgetExceeded(state, input.kind, event.bytes, maxEvents, notice)) {
        await transaction.query("rollback to savepoint timeline_append");
        await this.drop(transaction, input, state, notice);
        return { reason: "cap" };
      }
      await transaction.query(
        `update run_timeline_state set event_count = $2,
        byte_count = byte_count + $3, step_end_count = step_end_count + $4, step_end_bytes = step_end_bytes + $5,
        sealed_seq = case when $6 then $2 else sealed_seq end, sealed_at = case when $6 then $7 else sealed_at end where trigger_run_id = $1`,
        [
          input.triggerRunId,
          event.seq,
          isOrdinary(input.kind) ? event.bytes : 0,
          input.kind === "step_finished" ? 1 : 0,
          input.kind === "step_finished" ? event.bytes : 0,
          input.kind === "run_finished",
          input.at,
        ],
      );
      if (input.kind === "step_finished" && state.stepEndCount === 99) {
        state.stepEndCount += 1;
        await this.refreshOmitted(transaction, input.triggerRunId, state);
      }
      return { seq: event.seq, inserted: true };
    });
  }

  private async refreshOmitted(
    transaction: TransactionHandle,
    runId: string,
    state: RunTimelineState,
  ): Promise<void> {
    const count = (
      await transaction.query<{ count: number }>(
        `select count(*)::integer as count from workflow_step_runs where trigger_run_id = $1 and status in ('succeeded', 'failed', 'timed_out', 'skipped')`,
        [runId],
      )
    ).rows[0]!.count;
    state.stepRowsOmitted = Math.max(state.stepRowsOmitted, count - state.stepEndCount, 0);
    await transaction.query(
      `update run_timeline_state set step_rows_omitted = $2 where trigger_run_id = $1`,
      [runId, state.stepRowsOmitted],
    );
  }

  private async drop(
    transaction: TransactionHandle,
    input: AppendRunTimelineEventInput,
    state: RunTimelineState,
    notice: boolean,
  ): Promise<void> {
    if (isOrdinary(input.kind)) {
      state.droppedCount += 1;
      await transaction.query(
        `update run_timeline_state set dropped_count = $2 where trigger_run_id = $1`,
        [input.triggerRunId, state.droppedCount],
      );
    } else if (input.kind === "step_finished")
      await this.refreshOmitted(transaction, input.triggerRunId, state);
    if (!notice) {
      const noticeData = { dropped: state.droppedCount };
      await transaction.query(
        `insert into run_timeline_events (trigger_run_id, organization_id, seq, kind, at, step_id, data) values ($1,$2,$3,'truncated',$4,'',$5::jsonb)`,
        [
          input.triggerRunId,
          input.organizationId,
          state.eventCount + 1,
          input.at,
          JSON.stringify(noticeData),
        ],
      );
      await transaction.query(
        `update run_timeline_state set event_count = event_count + 1 where trigger_run_id = $1`,
        [input.triggerRunId],
      );
    }
  }

  async listRunTimelineEvents(
    organizationId: string,
    runId: string,
    page: { afterSeq: number; limit: number },
  ): Promise<RunTimelineEvent[]> {
    return (
      await this.runtime.query<Row<RunTimelineEvent>>(
        `select ${EVENT} from run_timeline_events where organization_id = $1 and trigger_run_id = $2 and seq > $3 order by seq limit $4`,
        [organizationId, runId, page.afterSeq, Math.max(0, Math.min(5110, page.limit))],
      )
    ).rows;
  }

  async readRunTimelineState(
    organizationId: string,
    runId: string,
  ): Promise<RunTimelineState | undefined> {
    return (
      await this.runtime.query<Row<RunTimelineState>>(
        `select ${STATE} from run_timeline_state where organization_id = $1 and trigger_run_id = $2`,
        [organizationId, runId],
      )
    ).rows[0];
  }

  async expireRunTimelines(cutoff: Date, batch: number): Promise<number> {
    return this.runtime.transaction(async (transaction) => {
      const expired = await transaction.query<{ id: string }>(
        `select run.id from trigger_runs run where run.status <> 'running' and run.completed_at < $1
        and (exists (select 1 from run_timeline_state state where state.trigger_run_id = run.id and state.expired_at is null)
          or exists (select 1 from run_progress_messages message where message.trigger_run_id = run.id))
        order by run.completed_at, run.id for update of run skip locked limit $2`,
        [cutoff, Math.max(0, Math.min(500, batch))],
      );
      const ids = expired.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      await transaction.query(
        `select trigger_run_id from run_timeline_state where trigger_run_id = any($1::uuid[]) order by trigger_run_id for update`,
        [ids],
      );
      await transaction.query(
        `delete from run_timeline_events where trigger_run_id = any($1::uuid[])`,
        [ids],
      );
      await transaction.query(
        `delete from run_progress_messages where trigger_run_id = any($1::uuid[])`,
        [ids],
      );
      await transaction.query(
        `update run_timeline_state set expired_at = $2, accounting_batch_ids = null where trigger_run_id = any($1::uuid[]) and expired_at is null`,
        [ids, cutoff],
      );
      return ids.length;
    });
  }

  async insertRunProgressMessageIfAbsent(
    input: InsertRunProgressMessageInput,
  ): Promise<RunProgressMessage | undefined> {
    return this.runtime.transaction(async (transaction) => {
      const run = await transaction.query(
        `select id from trigger_runs where id = $1 and organization_id = $2 and outcome = 'accepted' for key share`,
        [input.triggerRunId, input.organizationId],
      );
      if (run.rowCount === 0) return undefined;
      await transaction.query(
        `insert into run_progress_messages (trigger_run_id,organization_id,provider,created_at,updated_at)
        select id, organization_id, $3, $4, $4 from trigger_runs where id = $1 and organization_id = $2 and outcome = 'accepted'
        and not exists(select 1 from run_timeline_state where trigger_run_id = $1 and expired_at is not null)
        on conflict do nothing`,
        [input.triggerRunId, input.organizationId, input.provider, input.now],
      );
      return (
        await transaction.query<Row<RunProgressMessage>>(
          `select ${MESSAGE} from run_progress_messages where organization_id = $1 and trigger_run_id = $2`,
          [input.organizationId, input.triggerRunId],
        )
      ).rows[0];
    });
  }

  async findRunProgressMessage(
    organizationId: string,
    runId: string,
  ): Promise<RunProgressMessage | undefined> {
    return (
      await this.runtime.query<Row<RunProgressMessage>>(
        `select ${MESSAGE} from run_progress_messages where organization_id = $1 and trigger_run_id = $2`,
        [organizationId, runId],
      )
    ).rows[0];
  }

  async acquireRunProgressLease(
    input: RunProgressLeaseInput,
  ): Promise<RunProgressMessage | undefined> {
    return (
      await this.runtime.query<Row<RunProgressMessage>>(
        `update run_progress_messages set lease_owner = $3, lease_expires_at = $5, version = version + 1, updated_at = $4
      where trigger_run_id = $1 and organization_id = $2 and (lease_owner is null or lease_expires_at <= $4 or lease_owner = $3) returning ${MESSAGE}`,
        [
          input.triggerRunId,
          input.organizationId,
          input.owner,
          input.now,
          new Date(input.now.getTime() + 60000),
        ],
      )
    ).rows[0];
  }

  async updateRunProgressMessage(
    input: UpdateRunProgressMessageInput,
  ): Promise<RunProgressMessage | undefined> {
    const result = await this.runtime
      .drizzle()
      .update(runProgressMessages)
      .set({
        ...input.patch,
        updatedAt: input.now,
        ...(input.releaseLease === false ? {} : { leaseOwner: null, leaseExpiresAt: null }),
      })
      .where(
        and(
          eq(runProgressMessages.triggerRunId, input.triggerRunId),
          eq(runProgressMessages.organizationId, input.organizationId),
          eq(runProgressMessages.version, input.version),
          eq(runProgressMessages.leaseOwner, input.owner),
          gt(runProgressMessages.leaseExpiresAt, input.now),
        ),
      )
      .returning();
    return result[0];
  }

  async listOpenRunProgressMessages(
    afterRunId: string | null,
    limit: number,
  ): Promise<RunProgressMessage[]> {
    return (
      await this.runtime.query<Row<RunProgressMessage>>(
        `select ${MESSAGE} from run_progress_messages
         where ($1::uuid is null or trigger_run_id > $1) and (state in ('pending', 'active') or settle_at is not null)
         order by trigger_run_id limit $2`,
        [afterRunId, limit],
      )
    ).rows;
  }

  async listRunProgressMessagesToFinish(
    now: Date,
    limit: number,
    settleThrough = now,
  ): Promise<RunProgressMessage[]> {
    return (
      await this.runtime.query<Row<RunProgressMessage>>(
        `select ${MESSAGE.split(",")
          .map((part) => `message.${part.trim()}`)
          .join(",")} from run_progress_messages message
      join trigger_runs run on run.id = message.trigger_run_id
      where (message.state in ('creating','active') and message.lease_owner is not null and message.lease_expires_at <= $1)
        or (message.state = 'finished' and message.settle_at <= $3 and (message.retry_at is null or message.retry_at <= $3))
        or ((message.retry_at is null or message.retry_at <= $1) and (
          (message.state in ('active','finished') and message.compensation_requested_gen > message.compensation_done_gen and (message.compensation_not_before is null or message.compensation_not_before <= $1))
          or (message.state in ('pending','active') and run.status <> 'running')
          or (message.state = 'pending' and (exists(select 1 from run_timeline_events event where event.trigger_run_id = run.id and event.kind = 'run_started')
            or exists(select 1 from workflow_step_runs step where step.trigger_run_id = run.id and step.started_at is not null)))))
      order by message.updated_at, message.trigger_run_id limit $2`,
        [now, limit, settleThrough],
      )
    ).rows;
  }

  async requestCompensation(
    organizationId: string,
    runId: string,
    notBefore?: Date,
  ): Promise<number | undefined> {
    return (
      await this.runtime.query<{ generation: number }>(
        `update run_progress_messages set compensation_requested_gen = compensation_requested_gen + 1,
      compensation_not_before = case when $3::timestamptz is null then null
        when compensation_requested_gen > compensation_done_gen and compensation_not_before is null then null
        when compensation_requested_gen > compensation_done_gen then least(compensation_not_before, $3::timestamptz)
        else $3::timestamptz end where organization_id = $1 and trigger_run_id = $2 returning compensation_requested_gen as generation`,
        [organizationId, runId, notBefore ?? null],
      )
    ).rows[0]?.generation;
  }

  async completeCompensation(
    organizationId: string,
    runId: string,
    observedGen: number,
  ): Promise<void> {
    if (!Number.isInteger(observedGen) || observedGen < 0)
      throw new RangeError("Invalid compensation generation");
    await this.runtime.query(
      `update run_progress_messages set compensation_done_gen = greatest(compensation_done_gen, least(compensation_requested_gen, $3)) where organization_id = $1 and trigger_run_id = $2`,
      [organizationId, runId, observedGen],
    );
  }
}
