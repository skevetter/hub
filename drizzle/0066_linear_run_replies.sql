CREATE TABLE "run_reply_deliveries" (
	"trigger_run_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"comment_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"length" integer,
	"content_hash" text,
	"binding_hash" text,
	"attempted_at" timestamp with time zone,
	"failure" text,
	CONSTRAINT "run_reply_deliveries_comment_id_unique" UNIQUE("comment_id"),
	CONSTRAINT "run_reply_deliveries_state_check" CHECK (("run_reply_deliveries"."state" in ('pending', 'sending', 'sent') and "run_reply_deliveries"."failure" is null)
          or ("run_reply_deliveries"."state" = 'refused' and "run_reply_deliveries"."failure" is not null)),
	CONSTRAINT "run_reply_deliveries_attempt_check" CHECK (("run_reply_deliveries"."attempted_at" is null and "run_reply_deliveries"."state" in ('pending','refused')
              and "run_reply_deliveries"."length" is null and "run_reply_deliveries"."content_hash" is null and "run_reply_deliveries"."binding_hash" is null)
          or ("run_reply_deliveries"."attempted_at" is not null and "run_reply_deliveries"."state" in ('sending','sent','refused')
              and "run_reply_deliveries"."length" is not null and "run_reply_deliveries"."length" between 1 and 3500
              and "run_reply_deliveries"."content_hash" is not null and "run_reply_deliveries"."binding_hash" is not null))
);
--> statement-breakpoint
ALTER TABLE "run_reply_deliveries" ADD CONSTRAINT "run_reply_deliveries_run_organization_fk" FOREIGN KEY ("trigger_run_id","organization_id") REFERENCES "public"."trigger_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_reply_deliveries_organization_attempt_idx" ON "run_reply_deliveries" USING btree ("organization_id","attempted_at") WHERE "run_reply_deliveries"."attempted_at" is not null;--> statement-breakpoint
CREATE INDEX "run_reply_deliveries_repair_idx" ON "run_reply_deliveries" USING btree ("state","attempted_at") WHERE "run_reply_deliveries"."state" in ('pending', 'sending');