CREATE TABLE "member_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_identities_label_check" CHECK (char_length("member_identities"."label") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "surface_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"application_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"native_session_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"issue_id" text NOT NULL,
	"team_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"policy_revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "surface_bindings_revisions_check" CHECK ("surface_bindings"."generation" > 0 and "surface_bindings"."policy_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "surface_policies" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"application_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"scope" jsonb NOT NULL,
	"publish_answers" boolean DEFAULT false NOT NULL,
	"move_on_begin" text DEFAULT 'unchanged' NOT NULL,
	"move_on_finish" text DEFAULT 'unchanged' NOT NULL,
	"verified_app_handle" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "surface_policies_revision_check" CHECK ("surface_policies"."revision" > 0 and "surface_policies"."profile_version" > 0),
	CONSTRAINT "surface_policies_scope_check" CHECK (coalesce(jsonb_typeof("surface_policies"."scope"->'teamIds') = 'array', false)),
	CONSTRAINT "surface_policies_handle_check" CHECK (
      ("surface_policies"."verified_app_handle" is null and not "surface_policies"."enabled")
      or (char_length("surface_policies"."verified_app_handle") between 1 and 256
        and "surface_policies"."verified_app_handle" = btrim("surface_policies"."verified_app_handle")
        and "surface_policies"."verified_app_handle" !~ '[[:cntrl:]]'
        and "surface_policies"."verified_app_handle" is not null)
    ),
	CONSTRAINT "surface_policies_issue_state_check" CHECK (
      "surface_policies"."move_on_begin" in ('unchanged', 'started') and "surface_policies"."move_on_finish" = 'unchanged'
    )
);
--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD COLUMN "access" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD COLUMN "max_active" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD COLUMN "linear_template" text;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN "origin" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN "requester_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "member_identities" ADD CONSTRAINT "member_identities_member_org_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_identities" ADD CONSTRAINT "member_identities_workspace_org_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."linear_connections"("organization_id","linear_organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_session_org_fk" FOREIGN KEY ("session_id","organization_id") REFERENCES "public"."interactive_sessions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_policies" ADD CONSTRAINT "surface_policies_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."linear_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_policies" ADD CONSTRAINT "surface_policies_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."interactive_session_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_identities_workspace_user_unique" ON "member_identities" USING btree ("organization_id","workspace_id","provider_user_id");--> statement-breakpoint
CREATE INDEX "member_identities_member_idx" ON "member_identities" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_current_unique" ON "surface_bindings" USING btree ("workspace_id","application_id","app_user_id","native_session_id") WHERE "surface_bindings"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_generation_unique" ON "surface_bindings" USING btree ("workspace_id","application_id","app_user_id","native_session_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_id_org_unique" ON "surface_bindings" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "surface_bindings_session_org_idx" ON "surface_bindings" USING btree ("session_id","organization_id");--> statement-breakpoint
CREATE INDEX "surface_policies_profile_org_idx" ON "surface_policies" USING btree ("profile_id","organization_id");--> statement-breakpoint
CREATE INDEX "interactive_sessions_open_profile_idx" ON "interactive_sessions" USING btree ("organization_id","profile_id") WHERE "interactive_sessions"."state" <> 'closed';--> statement-breakpoint
ALTER TABLE "interactive_session_profiles" ADD CONSTRAINT "interactive_session_profiles_surface_check" CHECK ("interactive_session_profiles"."access" = 'private' and "interactive_session_profiles"."max_active" between 1 and 16
        and ("interactive_session_profiles"."linear_template" is null or octet_length("interactive_session_profiles"."linear_template") between 1 and 16384));--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_origin_check" CHECK (("interactive_sessions"."origin" = 'web' and "interactive_sessions"."requester_identity_id" is null)
        or ("interactive_sessions"."origin" = 'linear' and "interactive_sessions"."requester_identity_id" is not null));