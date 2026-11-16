CREATE UNIQUE INDEX "trigger_runs_id_organization_unique" ON "trigger_runs" USING btree ("id","organization_id");--> statement-breakpoint
CREATE TABLE "run_progress_messages" (
	"trigger_run_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"external_ref" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_rendered_hash" text,
	"last_edit_at" timestamp with time zone,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"visibility" text,
	"visibility_checked_at" timestamp with time zone,
	"failure" text,
	"compensation_requested_gen" integer DEFAULT 0 NOT NULL,
	"compensation_done_gen" integer DEFAULT 0 NOT NULL,
	"compensation_not_before" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_progress_messages_provider_check" CHECK ("run_progress_messages"."provider" in ('github', 'linear', 'slack')),
	CONSTRAINT "run_progress_messages_state_check" CHECK ("run_progress_messages"."state" in ('pending', 'creating', 'active', 'finished', 'gone', 'unavailable', 'refused', 'abandoned')),
	CONSTRAINT "run_progress_messages_visibility_check" CHECK ("run_progress_messages"."visibility" is null or "run_progress_messages"."visibility" in ('public', 'private', 'unknown')),
	CONSTRAINT "run_progress_messages_generation_check" CHECK ("run_progress_messages"."compensation_requested_gen" >= "run_progress_messages"."compensation_done_gen" and "run_progress_messages"."compensation_done_gen" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_timeline_events" (
	"trigger_run_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"step_id" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "run_timeline_events_trigger_run_id_seq_pk" PRIMARY KEY("trigger_run_id","seq"),
	CONSTRAINT "run_timeline_events_seq_check" CHECK ("run_timeline_events"."seq" between 1 and 5110),
	CONSTRAINT "run_timeline_events_kind_check" CHECK ("run_timeline_events"."kind" in ('run_started', 'step_started', 'agent_started', 'turn_started', 'turn_ended', 'tool_started', 'tool_finished', 'permission_requested', 'permission_resolved', 'turn_failed', 'turn_canceled', 'step_finished', 'run_finished', 'truncated')),
	CONSTRAINT "run_timeline_events_data_check" CHECK (octet_length("run_timeline_events"."data"::text) <= case when "run_timeline_events"."kind" = 'truncated' then 128 when "run_timeline_events"."kind" in ('step_finished', 'run_finished') then 512 else 1024 end)
);
--> statement-breakpoint
CREATE TABLE "run_timeline_state" (
	"trigger_run_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"byte_count" integer DEFAULT 0 NOT NULL,
	"step_end_count" integer DEFAULT 0 NOT NULL,
	"step_end_bytes" integer DEFAULT 0 NOT NULL,
	"step_rows_omitted" integer DEFAULT 0 NOT NULL,
	"dropped_count" integer DEFAULT 0 NOT NULL,
	"sealed_seq" integer,
	"sealed_at" timestamp with time zone,
	"origin" text NOT NULL,
	"expired_at" timestamp with time zone,
	CONSTRAINT "run_timeline_state_origin_check" CHECK ("run_timeline_state"."origin" in ('captured', 'derived')),
	CONSTRAINT "run_timeline_state_budget_check" CHECK ("run_timeline_state"."event_count" between 0 and 5102 and "run_timeline_state"."byte_count" between 0 and 196608 and "run_timeline_state"."step_end_count" between 0 and 100 and "run_timeline_state"."step_end_bytes" between 0 and 51200 and "run_timeline_state"."dropped_count" >= 0 and "run_timeline_state"."step_rows_omitted" >= 0)
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" DROP CONSTRAINT "organization_api_keys_scopes_check";--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD CONSTRAINT "run_progress_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD CONSTRAINT "run_progress_messages_run_organization_fk" FOREIGN KEY ("trigger_run_id","organization_id") REFERENCES "public"."trigger_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_timeline_events" ADD CONSTRAINT "run_timeline_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_timeline_events" ADD CONSTRAINT "run_timeline_events_run_organization_fk" FOREIGN KEY ("trigger_run_id","organization_id") REFERENCES "public"."trigger_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_timeline_state" ADD CONSTRAINT "run_timeline_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_timeline_state" ADD CONSTRAINT "run_timeline_state_run_organization_fk" FOREIGN KEY ("trigger_run_id","organization_id") REFERENCES "public"."trigger_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_progress_messages_sweep_idx" ON "run_progress_messages" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_timeline_events_lifecycle_unique" ON "run_timeline_events" USING btree ("trigger_run_id","kind","step_id") WHERE "run_timeline_events"."kind" in ('run_started', 'step_started', 'step_finished', 'run_finished', 'agent_started');--> statement-breakpoint
CREATE UNIQUE INDEX "run_timeline_events_call_unique" ON "run_timeline_events" USING btree ("trigger_run_id","step_id","kind",("data"->>'callId')) WHERE "run_timeline_events"."kind" in ('tool_started', 'tool_finished') and ("run_timeline_events"."data"->>'callId') is not null;--> statement-breakpoint
CREATE INDEX "run_timeline_events_organization_at_idx" ON "run_timeline_events" USING btree ("organization_id","at");--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_scopes_check" CHECK ("organization_api_keys"."scopes" <@ ARRAY['projects:read', 'configuration:validate', 'configuration:install', 'runs:dispatch', 'runs:read', 'daemons:enroll', 'events:send']::text[] and cardinality("organization_api_keys"."scopes") > 0);