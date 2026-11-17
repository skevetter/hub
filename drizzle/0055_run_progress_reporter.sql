ALTER TABLE "run_progress_messages" ADD COLUMN "failed_edits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "final_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "settle_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_progress_messages" ADD COLUMN "repeat_final" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "run_progress_messages_settle_idx" ON "run_progress_messages" USING btree ("settle_at") WHERE "run_progress_messages"."settle_at" is not null;