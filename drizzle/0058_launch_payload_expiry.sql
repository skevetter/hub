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
-- Match connection interpolation after execution environment overrides.
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
      WHEN jsonb_typeof(launch_intent -> 'environment') IS DISTINCT FROM 'object'
        OR jsonb_typeof(base_env) <> 'object' OR jsonb_typeof(execution_env) <> 'object' THEN null
      WHEN tokens.invalid THEN null
      ELSE coalesce(tokens.credentialed, false)
    END AS credentialed
  FROM environments
  CROSS JOIN LATERAL (
    SELECT bool_or(jsonb_typeof(entry.value) <> 'string'
      OR strpos(regexp_replace(entry.value #>> '{}', '\$\{\{(.*?)\}\}', '', 'gs'), '${{') > 0
      OR EXISTS (
        SELECT 1
        FROM regexp_matches(entry.value #>> '{}', '\$\{\{(.*?)\}\}', 'gs') AS match
        WHERE btrim(match[1], E' \t\n\r\v\f' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
          !~ '^paseo\.connections\.[a-z0-9]+(-[a-z0-9]+)*\.[a-z][a-z0-9_-]*$'
      )) AS invalid,
      bool_or(strpos(entry.value #>> '{}', '${{') > 0) AS credentialed
    FROM jsonb_each(CASE WHEN jsonb_typeof(base_env) = 'object' AND jsonb_typeof(execution_env) = 'object'
      THEN base_env || execution_env ELSE '{}'::jsonb END) AS entry
  ) AS tokens
)
UPDATE agent_executions AS execution
SET used_temporary_credentials = facts.credentialed
FROM facts
WHERE execution.id = facts.id AND facts.credentialed IS NOT NULL;
--> statement-breakpoint
UPDATE agent_sessions
SET creation_options = data -> 'creationOptions'
WHERE data ? 'creationOptions';
