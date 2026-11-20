ALTER TABLE "trigger_runs" DROP CONSTRAINT "trigger_runs_status_check";--> statement-breakpoint
ALTER TABLE "workflow_step_runs" DROP CONSTRAINT "workflow_step_runs_status_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "started_by_user_id" text;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_status_check" CHECK ("trigger_runs"."status" in ('running', 'succeeded', 'failed', 'timed_out', 'canceled', 'rejected'));--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_status_check" CHECK ("workflow_step_runs"."status" in ('pending', 'running', 'succeeded', 'skipped', 'failed', 'timed_out', 'canceled'));