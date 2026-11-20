import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./app.js";

test.use({ viewport: { width: 390, height: 844 } });

for (const scenario of ["joins", "finishes", "repeat"] as const) {
  const startsShared = scenario === "finishes";
  test(
    scenario === "repeat"
      ? "asks for a fresh confirmation before repeating an unconfirmed Stop"
      : `reconfirms when attached work ${scenario} after Stop opens`,
    async ({ hub, page }) => {
      test.setTimeout(90_000);
      await hub.signUpAs("owner", {
        name: "Stop Owner",
        email: "stop-owner@example.test",
        password: "local-stop-test-password",
      });
      await hub.createOrganization("owner", "Stop Review");
      const app = hub.primaryApplication();
      const query = (sql: string, params: unknown[] = []) => app.query(sql, params);
      const [org] = await query("select id, slug from organization where name = 'Stop Review'");
      const organizationId = org?.["id"];
      const organizationSlug = org?.["slug"];
      if (typeof organizationId !== "string" || typeof organizationSlug !== "string") {
        throw new Error("missing test organization");
      }
      const projectId = randomUUID();
      const revisionId = randomUUID();
      const daemonId = randomUUID();
      const machineId = randomUUID();
      await query(
        "insert into projects (id,organization_id,slug,name) values ($1,$2,'stop-review','Stop Review')",
        [projectId, organizationId],
      );
      await query(
        `insert into project_configuration_revisions
      (id,organization_id,project_id,version,source_kind,source_evidence,normalized_configuration,content_hash)
      values ($1,$2,$3,1,'manual','{}','{"environments":[],"triggers":[]}','review')`,
        [revisionId, organizationId, projectId],
      );
      await query("insert into machines (id,org_id,source,status) values ($1,$2,$3,'alive')", [
        machineId,
        organizationId,
        { kind: "daemon", daemonId },
      ]);
      await query(
        `insert into daemons (id,idempotency_key,enrollment_verifier,slug,machine_id,organization_id,
      server_id,daemon_public_key,credential_verifier,scopes,status)
    values ($1,'review','review','review',$2,$3,'review','review','review','[]','active')`,
        [daemonId, machineId, organizationId],
      );
      const seed = async (sessionId: string) => {
        const receipt = randomUUID(),
          run = randomUUID();
        await query(
          `insert into provider_event_receipts (id,organization_id,provider,delivery_id,source,payload,started_by_user_id)
      values ($1,$2,'manual',$1::uuid::text,'manual.run','{"private":"receipt-content"}',$3)`,
          [receipt, organizationId, null],
        );
        await query(
          `insert into trigger_runs (id,organization_id,project_id,configuration_revision_id,provider_event_receipt_id,
      configured_trigger_name,status,prompt,deadline_at,completed_at)
      values ($1,$2,$3,$4,$5,'review',$6,'private prompt',now()+interval '1 hour',
      case when $6='running' then null else now() end)`,
          [run, organizationId, projectId, revisionId, receipt, "running"],
        );
        {
          const step = randomUUID(),
            execution = randomUUID();
          await query(
            "insert into workflow_step_runs (id,trigger_run_id,step_id,ordinal,status) values ($1,$2,'work',0,'running')",
            [step, run],
          );
          await query(
            `insert into agent_executions (id,organization_id,project_id,configuration_revision_id,
       workflow_step_run_id,agent_session_id,daemon_id,daemon_agent_id,status,started_at,deadline_at)
       values ($1,$2,$3,$4,$5,$6,$7,'offline-agent','running',now(),now()+interval '1 hour')`,
            [execution, organizationId, projectId, revisionId, step, sessionId, daemonId],
          );
          await query("update workflow_step_runs set agent_execution_id=$1 where id=$2", [
            execution,
            step,
          ]);
        }
        return run;
      };
      const session = async () => {
        const s = randomUUID();
        await query(
          "insert into agent_sessions (id,organization_id,project_id,continuation_key,data) values ($1,$2,$3,$1::uuid::text,$4)",
          [
            s,
            organizationId,
            projectId,
            {
              id: s,
              organizationId,
              projectId,
              agentId: "offline-agent",
              daemonId,
              workspaceId: "offline-workspace",
            },
          ],
        );
        return s;
      };

      const sessionId = await session();
      const target = await seed(sessionId);
      const peer = startsShared ? await seed(sessionId) : undefined;
      await page.goto(`${app.origin}/o/${organizationSlug}/activity/${target}`);
      await expect(page.getByRole("heading", { name: "Run detail", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stop run", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Stop this run?" });
      const confirm = dialog.getByRole("button", { name: "Stop run", exact: true });
      await expect(confirm).toBeEnabled();
      const sharedWarning = /another run|1 other run/u;
      if (startsShared) await expect(dialog).toContainText(sharedWarning);
      else await expect(dialog).not.toContainText(sharedWarning);

      if (scenario === "repeat") {
        await confirm.click();
        await expect(dialog).toBeHidden();
        await expect(
          page.getByText("Hub is waiting for the daemon to finish cleanup."),
        ).toBeVisible();
        await query(
          `update agent_executions
         set hub_action_completed_at = now(),
             hub_action_acknowledgements = jsonb_set(hub_action_acknowledgements,
               '{stop_interrupt,outcome}', '"delivery_unconfirmed"')
         where workflow_step_run_id in (select id from workflow_step_runs where trigger_run_id = $1)`,
          [target],
        );
        await expect(page.getByText("Hub could not confirm interrupt delivery.")).toBeVisible({
          timeout: 12_000,
        });
        await page.getByRole("button", { name: "Stop again", exact: true }).click();
        const repeat = page.getByRole("alertdialog", { name: "Send another interrupt?" });
        await expect(repeat).toContainText(
          "Hub could not confirm delivery of the previous interrupt.",
        );
        await repeat.getByRole("button", { name: "Stop again", exact: true }).click();
        await expect(repeat).toBeHidden();
        await expect(
          page.getByText("Hub is waiting for the daemon to finish cleanup."),
        ).toBeVisible();
        expect(
          await query(
            "select id from audit_events where subject_id = $1 and action = 'run.canceled'",
            [target],
          ),
        ).toHaveLength(1);
        return;
      }

      if (peer === undefined) {
        await seed(sessionId);
      } else {
        await query(
          `update agent_executions set status = 'succeeded', completed_at = now()
        where workflow_step_run_id in (select id from workflow_step_runs where trigger_run_id = $1)`,
          [peer],
        );
      }
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" && candidate.url().includes("_serverFn"),
      );
      await confirm.click();
      expect((await response).status()).toBe(409);
      await expect(dialog).toContainText("Review the updated impact and confirm again.");
      if (startsShared) await expect(dialog).not.toContainText(sharedWarning);
      else await expect(dialog).toContainText(sharedWarning);
      expect(await query("select status from trigger_runs where id = $1", [target])).toEqual([
        { status: "running" },
      ]);
      expect(
        await query(
          "select id from audit_events where subject_id = $1 and action = 'run.canceled'",
          [target],
        ),
      ).toEqual([]);

      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => query("select status from trigger_runs where id = $1", [target]))
        .toEqual([{ status: "canceled" }]);
    },
  );
}
