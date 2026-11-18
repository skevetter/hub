CREATE TABLE "organization_webhook_secrets" (
	"organization_id" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"version_id" uuid NOT NULL,
	"master_key_id" text NOT NULL,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accept_until" timestamp with time zone,
	CONSTRAINT "organization_webhook_secrets_api_key_id_slot_pk" PRIMARY KEY("api_key_id","slot"),
	CONSTRAINT "organization_webhook_secrets_version_id_unique" UNIQUE("version_id"),
	CONSTRAINT "organization_webhook_secrets_slot_check" CHECK (("organization_webhook_secrets"."slot" = 'current' and "organization_webhook_secrets"."accept_until" is null)
        or ("organization_webhook_secrets"."slot" = 'previous' and "organization_webhook_secrets"."accept_until" is not null)),
	CONSTRAINT "organization_webhook_secrets_material_check" CHECK ("organization_webhook_secrets"."master_key_id" ~ '^[A-Za-z0-9_-]{1,64}$'
        and "organization_webhook_secrets"."salt" ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$')
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD COLUMN "webhook_auth_mode" text;--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD COLUMN "webhook_signature_profile" text;--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD COLUMN "webhook_target_trigger_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_api_keys_org_id_unique" ON "organization_api_keys" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "organization_webhook_secrets" ADD CONSTRAINT "organization_webhook_secrets_parent_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."organization_api_keys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_webhook_auth_check" CHECK ((
        "organization_api_keys"."webhook_auth_mode" is null and "organization_api_keys"."webhook_signature_profile" is null
        and "organization_api_keys"."webhook_target_trigger_id" is null
      ) or (
        "organization_api_keys"."webhook_auth_mode" is not null and "organization_api_keys"."webhook_auth_mode" = 'hmac'
        and "organization_api_keys"."webhook_signature_profile" is not null
        and "organization_api_keys"."webhook_signature_profile" = 'github_sha256'
        and "organization_api_keys"."webhook_target_trigger_id" is not null and "organization_api_keys"."actor" is not null
        and "organization_api_keys"."scopes" = ARRAY['events:send']::text[]
        and "organization_api_keys"."allowed_triggers" is not null and cardinality("organization_api_keys"."allowed_triggers") = 1
        and coalesce("organization_api_keys"."allowed_triggers"[1] ~ '^[a-z][a-z0-9_-]*$', false)
      ));
