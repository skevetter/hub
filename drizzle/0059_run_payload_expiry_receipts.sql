ALTER TABLE "github_installation_syncs" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_installation_syncs" ADD COLUMN "audit_link" jsonb;--> statement-breakpoint
ALTER TABLE "github_installation_syncs" ADD COLUMN "payload_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_notification_cursors" ADD COLUMN "diagnostic_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "payload_expiry_state" text;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "payload_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "pre_routing_drop" text;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "manual_replay_binding" jsonb;--> statement-breakpoint
ALTER TABLE "github_installation_syncs" ADD CONSTRAINT "github_installation_syncs_settlement_check" CHECK (("github_installation_syncs"."settled_at" is null and "github_installation_syncs"."audit_link" is null and "github_installation_syncs"."payload_expired_at" is null)
        or ("github_installation_syncs"."kind" = 'webhook' and "github_installation_syncs"."settled_at" is not null
            and "github_installation_syncs"."retry_at" is null and "github_installation_syncs"."audit_link" is not null));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_payload_expiry_check" CHECK (("provider_event_receipts"."payload_expiry_state" is null and "provider_event_receipts"."payload_expired_at" is null)
        or ("provider_event_receipts"."payload_expiry_state" is not null and "provider_event_receipts"."payload_expiry_state" in ('expiring', 'expired')
            and "provider_event_receipts"."payload_expired_at" is not null));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_pre_routing_drop_check" CHECK ("provider_event_receipts"."pre_routing_drop" is null or ("provider_event_receipts"."pre_routing_drop" in ('no_project_route', 'no_trigger_for_source', 'configuration_unavailable')
        and "provider_event_receipts"."pre_routing_drop" is not distinct from "provider_event_receipts"."dropped_reason" and "provider_event_receipts"."accepted_routes" is null));