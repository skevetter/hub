CREATE TABLE "account_attention_state" (
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"failed_runs_seen_through" timestamp with time zone NOT NULL,
	CONSTRAINT "account_attention_state_account_id_organization_id_pk" PRIMARY KEY("account_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "account_attention_state" ADD CONSTRAINT "account_attention_state_account_id_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_attention_state" ADD CONSTRAINT "account_attention_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;