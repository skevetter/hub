CREATE TABLE "interactive_session_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"generation" integer NOT NULL,
	"kind" text NOT NULL,
	"delivery" text,
	"status" text NOT NULL,
	"failure_code" text,
	"body" text,
	"body_expired_at" timestamp with time zone,
	"author_user_id" text,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "interactive_session_commands_kind_check" CHECK ("interactive_session_commands"."kind" in ('message', 'stop', 'close', 'replace')),
	CONSTRAINT "interactive_session_commands_status_check" CHECK ("interactive_session_commands"."status" in ('pending', 'queued', 'dispatching', 'delivered', 'unknown', 'superseded', 'failed', 'done')),
	CONSTRAINT "interactive_session_commands_delivery_check" CHECK (("interactive_session_commands"."kind" = 'message') = ("interactive_session_commands"."delivery" is not null) and "interactive_session_commands"."delivery" in ('steer', 'queue')),
	CONSTRAINT "interactive_session_commands_body_check" CHECK (octet_length("interactive_session_commands"."body") <= 16384 and
      ("interactive_session_commands"."kind" <> 'message' or "interactive_session_commands"."body" is not null or "interactive_session_commands"."body_expired_at" is not null) and
      ("interactive_session_commands"."body_expired_at" is null or "interactive_session_commands"."body" is null)),
	CONSTRAINT "interactive_session_commands_failure_check" CHECK ("interactive_session_commands"."failure_code" in ('key_conflict', 'agent_missing', 'daemon_rejected', 'launch_failed', 'delivery_unconfirmed'))
);
--> statement-breakpoint
CREATE TABLE "interactive_session_events" (
	"session_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"command_id" uuid,
	"data" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "interactive_session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq"),
	CONSTRAINT "interactive_session_events_kind_check" CHECK ("interactive_session_events"."kind" in ('message', 'delivery', 'state', 'participants')),
	CONSTRAINT "interactive_session_events_data_check" CHECK (octet_length("interactive_session_events"."data"::text) <= 1024)
);
--> statement-breakpoint
CREATE TABLE "interactive_session_participants" (
	"session_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interactive_session_participants_session_id_user_id_pk" PRIMARY KEY("session_id","user_id"),
	CONSTRAINT "interactive_session_participants_role_check" CHECK ("interactive_session_participants"."role" in ('controller', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "interactive_session_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"daemon_id" uuid NOT NULL,
	"cwd" text NOT NULL,
	"worktree" jsonb,
	"provider" text NOT NULL,
	"model" text,
	"mode" text,
	"thinking_option_id" text,
	"provider_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"full_access_acknowledged" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interactive_session_profiles_name_check" CHECK (char_length("interactive_session_profiles"."name") between 1 and 80),
	CONSTRAINT "interactive_session_profiles_cwd_check" CHECK (octet_length("interactive_session_profiles"."cwd") <= 1024 and (
      left("interactive_session_profiles"."cwd", 1) = '/' or left("interactive_session_profiles"."cwd", 2) = repeat(chr(92), 2)
      or (left("interactive_session_profiles"."cwd", 2) ~ '^[A-Za-z]:$' and substr("interactive_session_profiles"."cwd", 3, 1) in ('/', chr(92))))),
	CONSTRAINT "interactive_session_profiles_worktree_check" CHECK ("interactive_session_profiles"."worktree" is null or (
      jsonb_typeof("interactive_session_profiles"."worktree") = 'object' and
      "interactive_session_profiles"."worktree" @> '{"mode":"branch-off"}'::jsonb and
      "interactive_session_profiles"."worktree" - 'mode' - 'base' = '{}'::jsonb and
      (not ("interactive_session_profiles"."worktree" ? 'base') or jsonb_typeof("interactive_session_profiles"."worktree"->'base') = 'string'))),
	CONSTRAINT "interactive_session_profiles_options_check" CHECK (jsonb_typeof("interactive_session_profiles"."provider_options") = 'object' and octet_length("interactive_session_profiles"."provider_options"::text) <= 4096),
	CONSTRAINT "interactive_session_profiles_access_check" CHECK ("interactive_session_profiles"."provider" <> 'omp' or
      ("interactive_session_profiles"."mode" is not null and ("interactive_session_profiles"."mode" <> 'full' or "interactive_session_profiles"."full_access_acknowledged"))),
	CONSTRAINT "interactive_session_profiles_status_check" CHECK ("interactive_session_profiles"."status" in ('active', 'disabled') and "interactive_session_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "interactive_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"launch" jsonb NOT NULL,
	"daemon_id" uuid NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"state_reason" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"daemon_agent_id" text,
	"daemon_workspace_id" text,
	"hub_seq" integer DEFAULT 0 NOT NULL,
	"command_seq" integer DEFAULT 0 NOT NULL,
	"started_by_user_id" text,
	"start_idempotency_key" uuid NOT NULL,
	"start_request_hash" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" text,
	CONSTRAINT "interactive_sessions_state_check" CHECK ("interactive_sessions"."state" in ('starting', 'running', 'idle', 'waiting_permission', 'stopping', 'failed', 'closed')),
	CONSTRAINT "interactive_sessions_reason_check" CHECK ("interactive_sessions"."state_reason" in ('stopped_by_person', 'launch_failed', 'agent_missing', 'daemon_revoked', 'closed_by_person')),
	CONSTRAINT "interactive_sessions_closed_check" CHECK (("interactive_sessions"."state" = 'closed') = ("interactive_sessions"."closed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_session_commands_id_session_org_unique" ON "interactive_session_commands" USING btree ("id","session_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_session_profiles_id_org_unique" ON "interactive_session_profiles" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_sessions_id_org_unique" ON "interactive_sessions" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "interactive_session_commands" ADD CONSTRAINT "interactive_session_commands_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_commands" ADD CONSTRAINT "interactive_session_commands_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_commands" ADD CONSTRAINT "interactive_session_commands_session_org_fk" FOREIGN KEY ("session_id","organization_id") REFERENCES "public"."interactive_sessions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_events" ADD CONSTRAINT "interactive_session_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_events" ADD CONSTRAINT "interactive_session_events_session_org_fk" FOREIGN KEY ("session_id","organization_id") REFERENCES "public"."interactive_sessions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_events" ADD CONSTRAINT "interactive_session_events_command_session_org_fk" FOREIGN KEY ("command_id","session_id","organization_id") REFERENCES "public"."interactive_session_commands"("id","session_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_participants" ADD CONSTRAINT "interactive_session_participants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_participants" ADD CONSTRAINT "interactive_session_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_participants" ADD CONSTRAINT "interactive_session_participants_added_by_user_id_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_participants" ADD CONSTRAINT "interactive_session_participants_session_org_fk" FOREIGN KEY ("session_id","organization_id") REFERENCES "public"."interactive_sessions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_participants" ADD CONSTRAINT "interactive_session_participants_member_org_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD CONSTRAINT "interactive_session_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD CONSTRAINT "interactive_session_profiles_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD CONSTRAINT "interactive_session_profiles_daemon_org_fk" FOREIGN KEY ("daemon_id","organization_id") REFERENCES "public"."daemons"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."interactive_session_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_daemon_org_fk" FOREIGN KEY ("daemon_id","organization_id") REFERENCES "public"."daemons"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_session_commands_ordinal_unique" ON "interactive_session_commands" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_session_commands_key_unique" ON "interactive_session_commands" USING btree ("session_id","author_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "interactive_session_commands_dispatch_idx" ON "interactive_session_commands" USING btree ("session_id","ordinal") WHERE "interactive_session_commands"."status" in ('pending', 'queued', 'dispatching', 'unknown');--> statement-breakpoint
CREATE INDEX "interactive_session_commands_expiry_idx" ON "interactive_session_commands" USING btree ("created_at") WHERE "interactive_session_commands"."body" is not null;--> statement-breakpoint
CREATE INDEX "interactive_session_participants_org_user_idx" ON "interactive_session_participants" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_session_profiles_org_name_unique" ON "interactive_session_profiles" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_sessions_start_key_unique" ON "interactive_sessions" USING btree ("organization_id","started_by_user_id","start_idempotency_key");--> statement-breakpoint
CREATE INDEX "interactive_sessions_org_activity_idx" ON "interactive_sessions" USING btree ("organization_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "interactive_sessions_open_daemon_idx" ON "interactive_sessions" USING btree ("daemon_id") WHERE "interactive_sessions"."state" <> 'closed';