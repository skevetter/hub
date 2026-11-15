ALTER TABLE "github_notification_cursors" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_notification_cursors" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "github_notification_cursors" ADD COLUMN "last_error_at" timestamp with time zone;