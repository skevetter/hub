ALTER TABLE "run_progress_messages" ADD COLUMN "last_regular_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "credential_key" text;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "credential_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "credential_rejected_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "run_progress_messages_credential_idx" ON "run_progress_messages" USING btree ("credential_key") WHERE "run_progress_messages"."credential_key" is not null;