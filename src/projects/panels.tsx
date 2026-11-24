/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-unsafe-type-assertion -- route links and mutation controls are intentionally scoped to each rendered tenant snapshot */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type SubmitEvent, type ReactNode } from "react";
import { Card } from "../components/app/card.js";
import { ConfirmAction } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField } from "../components/app/form-field.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { Button } from "../components/ui/button.js";
import { DaemonsPanel } from "../daemons/account-daemons.js";
import { useRouteTenant } from "./context.js";
import {
  CommandError,
  invalidateScope,
  projectScope,
  useProjectCommand,
  useProjectSnapshot,
  type ProjectSnapshot,
} from "./panel-state.js";
import { archiveProject, updateProjectSlug } from "./functions.js";
export { OrganizationConnectionsPanel } from "../connections/panel.js";

export function OrganizationDaemonsPanel() {
  const tenant = useRouteTenant();
  return (
    <DaemonsPanel
      accountId={tenant.account.id}
      organizationId={tenant.organization.id}
      organizationSlug={tenant.organization.slug}
    />
  );
}

export function ProjectOverviewPanel() {
  const tenant = useRouteTenant();
  const snapshot = useProjectSnapshot();
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const base = `/o/${tenant.organization.slug}/projects/${data.project.slug}`;
  return (
    <>
      <PageHeader
        title="Overview"
        description={`Setup and recent operations for ${data.project.name}.`}
      />
      <Section className="sm:grid-cols-2">
        <SetupCard
          label="Configuration"
          ready={data.configuration.activeRevision !== null}
          detail={
            data.configuration.activeRevision === null
              ? "No active revision"
              : `Revision ${String(data.configuration.activeRevision.version)}`
          }
        />
        <SetupCard
          label="Connections"
          ready={
            data.connections.github.length +
              data.connections.discord.length +
              data.connections.slack.length +
              data.connections.linear.length >
            0
          }
          detail={`${String(data.connections.github.length + data.connections.discord.length + data.connections.slack.length + data.connections.linear.length)} organization connections`}
        />
      </Section>
      <Section
        title="Recent activity"
        action={
          <Button variant="link" asChild>
            <Link to={`${base}/activity` as never}>View all</Link>
          </Button>
        }
      >
        <ActivityTable
          activity={data.activity.slice(0, 5)}
          label="Recent activity"
          detailBasePath={`${base}/activity`}
        />
      </Section>
    </>
  );
}

export function ProjectActivityPanel() {
  const tenant = useRouteTenant();
  const snapshot = useProjectSnapshot();
  if (!snapshot.ok) return snapshot.element;
  return (
    <>
      <PageHeader title="Activity" description="Provider events routed to this project." />
      <ActivityTable
        activity={snapshot.data.activity}
        label="Project activity"
        detailBasePath={`/o/${tenant.organization.slug}/projects/${tenant.project?.slug}/activity`}
      />
    </>
  );
}

export function ProjectGeneralSettingsPanel() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scope = projectScope(tenant);
  const snapshot = useProjectSnapshot();
  const updateSlug = useProjectCommand(updateProjectSlug, queryClient, scope);
  // Archiving deletes the route this panel is standing on: the project stops resolving
  // for every project URL. Leave for the project list before invalidating, or the
  // refetch lands on a project route that can no longer answer.
  const archiveProjectFn = useServerFn(archiveProject);
  const archive = useMutation({
    mutationFn: archiveProjectFn,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      await navigate({ to: `/o/${tenant.organization.slug}/projects` as never });
      await invalidateScope(queryClient, scope);
    },
  });
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const slug = formString(new FormData(event.currentTarget), "slug");
    updateSlug.mutate(
      { data: { ...scope, slug } },
      {
        onSuccess: (result) => {
          if (result.status === "ok")
            void navigate({
              to: `/o/${tenant.organization.slug}/projects/${slug}/settings` as never,
            });
        },
      },
    );
  };
  return (
    <SettingsPage>
      <CommandError mutations={[updateSlug, archive]} />
      {data.capabilities.manageResources
        ? renderProjectSettingsActions({
            project: data.project,
            submit,
            archiving: archive.isPending,
            onArchive: () => archive.mutate({ data: scope }),
          })
        : null}
    </SettingsPage>
  );
}

function renderProjectSettingsActions({
  project,
  submit,
  archiving,
  onArchive,
}: {
  project: ProjectSnapshot["project"];
  submit: (event: SubmitEvent<HTMLFormElement>) => void;
  archiving: boolean;
  onArchive: () => void;
}) {
  return (
    <>
      <Section
        title="Project URL"
        description="Changing the slug deliberately breaks old project URLs."
      >
        <form aria-label="Change project slug" className="grid max-w-md gap-4" onSubmit={submit}>
          <FormField
            id="project-slug"
            label="Project slug"
            kind="text"
            name="slug"
            defaultValue={project.slug}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
          <FormActions>
            <Button type="submit">Save slug</Button>
          </FormActions>
        </form>
      </Section>
      <Section title="Archive project">
        <ConfirmAction
          label="Archive project"
          title={`Archive ${project.name}?`}
          description="Routing is released; running recovery and history remain."
          confirmLabel="Archive project"
          cancelLabel="Cancel"
          busy={archiving}
          onConfirm={onArchive}
        />
      </Section>
    </>
  );
}

function SettingsPage({ children }: { children: ReactNode }) {
  const tenant = useRouteTenant();
  if (tenant.project === null) throw new Error("settings route has no project");
  return (
    <>
      <PageHeader title="Settings" description={`Project settings for ${tenant.project.name}.`} />
      {children}
    </>
  );
}

function SetupCard({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <Card
      title={label}
      action={
        <StatusPill tone={ready ? "success" : "neutral"}>
          {ready ? "Ready" : "Setup needed"}
        </StatusPill>
      }
    >
      <p className="text-sm text-muted-foreground">{detail}</p>
    </Card>
  );
}

function executionTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  if (status === "dropped") return "warning";
  return "neutral";
}

function ActivityTable({
  activity,
  label,
  detailBasePath,
}: {
  activity: ReadonlyArray<ProjectSnapshot["activity"][number]>;
  label: string;
  detailBasePath?: string;
}) {
  return (
    <DataTable
      label={label}
      columns={[
        { header: "Run", fill: true },
        { header: "Provider" },
        { header: "Source" },
        { header: "Status" },
        { header: "Received" },
      ]}
      isEmpty={activity.length === 0}
      empty={{ title: "No activity" }}
    >
      {activity.map((event) => renderActivityRow(event, detailBasePath))}
    </DataTable>
  );
}

function renderActivityRow(event: ProjectSnapshot["activity"][number], detailBasePath?: string) {
  const { status } = event;
  return (
    <DataRow key={event.id}>
      <DataCell>
        <TwoLine
          primary={
            detailBasePath && event.configuredTriggerName !== null ? (
              <Button variant="link" asChild>
                <Link to={`${detailBasePath}/${event.id}` as never}>
                  {event.configuredTriggerName}
                </Link>
              </Button>
            ) : (
              <span className="font-mono">{event.id.slice(0, 12)}</span>
            )
          }
          {...(event.repo === null ? {} : { secondary: event.repo })}
        />
      </DataCell>
      <DataCell>{event.provider}</DataCell>
      <DataCell>
        <div className="flex items-center gap-2">
          <ProviderGlyph provider={event.provider} source={event.source} />
          <TwoLine
            primary={activitySourceLabel(event)}
            {...("webhookSummary" in event && event.webhookSummary?.prompt !== undefined
              ? { secondary: event.webhookSummary.prompt }
              : {})}
          />
        </div>
      </DataCell>
      <DataCell>
        <StatusPill tone={executionTone(status)}>{statusLabel(status)}</StatusPill>
      </DataCell>
      <DataCell muted>
        <RelativeTime value={event.receivedAt} />
      </DataCell>
    </DataRow>
  );
}

function formString(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function activitySourceLabel(event: {
  source: string;
  payloadExpiredAt?: string | null;
  webhookSummary?: { headline: string };
}) {
  if (event.payloadExpiredAt != null) return "Run payload expired";
  return event.webhookSummary?.headline ?? event.source;
}
