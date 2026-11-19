ALTER TABLE "agent_executions" ADD COLUMN "used_temporary_credentials" boolean;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "launch_intent_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "launch_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "launch_agent" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "creation_options" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "options_reduced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_executions_launch_run_idx" ON "agent_executions" USING btree ("organization_id","project_id","launch_run_id") WHERE "agent_executions"."launch_run_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_launch_expiry_check" CHECK ("agent_executions"."launch_intent_expired_at" is null or
        ("agent_executions"."launch_intent" is null and "agent_executions"."used_temporary_credentials" is not null));--> statement-breakpoint
-- Leave interpolation and legacy values to the TypeScript predicate.
WITH environments AS (
  SELECT id, launch_intent,
    coalesce(launch_intent #> '{environment,env}', '{}'::jsonb) AS base_env,
    coalesce(launch_intent -> 'env', '{}'::jsonb) AS execution_env
  FROM agent_executions
  WHERE jsonb_typeof(launch_intent) = 'object'
), facts AS (
  SELECT id,
    CASE
      WHEN launch_intent ? 'github' THEN true
      WHEN jsonb_typeof(launch_intent -> 'environment') = 'object'
        AND jsonb_typeof(base_env) = 'object' AND jsonb_typeof(execution_env) = 'object'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(base_env) = 'object'
            AND jsonb_typeof(execution_env) = 'object' THEN base_env || execution_env
            ELSE '{}'::jsonb END) AS entry
          WHERE jsonb_typeof(entry.value) <> 'string' OR strpos(entry.value #>> '{}', '${{') > 0
        ) THEN false
    END AS credentialed
  FROM environments
)
UPDATE agent_executions AS execution
SET used_temporary_credentials = facts.credentialed
FROM facts
WHERE execution.id = facts.id AND facts.credentialed IS NOT NULL;
--> statement-breakpoint
UPDATE agent_sessions
SET creation_options = data -> 'creationOptions'
WHERE data ? 'creationOptions';
