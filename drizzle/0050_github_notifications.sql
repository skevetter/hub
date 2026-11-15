CREATE TABLE "github_notification_cursors" (
	"source" text PRIMARY KEY NOT NULL,
	"last_modified" text,
	"since" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'manual', 'schedule', 'github_notification'));