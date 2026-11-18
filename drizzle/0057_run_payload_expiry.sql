ALTER TABLE "agent_executions" ADD COLUMN "payload_completion" text;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "terminal_notification_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "payload_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "payload_expiry_state" text;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "payload_summary" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "payload_summary" jsonb;--> statement-breakpoint
CREATE INDEX "agent_executions_workflow_step_idx" ON "agent_executions" USING btree ("workflow_step_run_id") WHERE "agent_executions"."workflow_step_run_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_executions_legacy_run_idx" ON "agent_executions" USING btree ("organization_id","project_id",("launch_intent" ->> 'triggerRunId')) WHERE "agent_executions"."workflow_step_run_id" is null and "agent_executions"."launch_intent" ->> 'kind' = 'launch_machine';--> statement-breakpoint
CREATE INDEX "trigger_runs_payload_expiry_idx" ON "trigger_runs" USING btree ("completed_at","id") WHERE "trigger_runs"."status" <> 'running' and "trigger_runs"."payload_expiry_state" is distinct from 'expired';--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_payload_expiry_check" CHECK (("trigger_runs"."payload_expiry_state" is null and "trigger_runs"."payload_expired_at" is null and "trigger_runs"."payload_summary" is null)
        or ("trigger_runs"."payload_expiry_state" is not null and "trigger_runs"."payload_expiry_state" in ('expiring', 'expired')
            and "trigger_runs"."payload_expired_at" is not null and "trigger_runs"."payload_summary" is not null));