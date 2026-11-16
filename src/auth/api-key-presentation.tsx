import { useCallback } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { CopyBlock, CopyField } from "../components/app/copy-field.js";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { FormField } from "../components/app/form-field.js";
import { LoadingLine } from "../components/app/loading.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { StatusPill } from "../components/app/status-pill.js";
import { FieldDescription, FieldError } from "../components/ui/field.js";
import type { Snapshot } from "../queries/index.js";
import { webhookCurl } from "../webhooks/contract.js";
import { apiKeyCreateSchema, defaultApiKeyActor, type ApiKeyScope } from "./api-key-contract.js";

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  actor: string | null;
  allowedTriggers: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const SCOPE_OPTIONS = [
  {
    value: "projects:read",
    label: "List projects",
    description: "List active projects in the organization.",
  },
  {
    value: "configuration:validate",
    label: "Validate configuration",
    description: "Validate configuration without creating a revision.",
  },
  {
    value: "configuration:install",
    label: "Install configuration",
    description: "Replace and activate a project's configuration.",
  },
  {
    value: "runs:dispatch",
    label: "Start runs",
    description: "Dispatch manual runs for a project.",
  },
  {
    value: "events:send",
    label: "Send events",
    description: "Send authenticated events to webhook triggers as this key's actor.",
  },
  {
    value: "daemons:enroll",
    label: "Enroll daemons",
    description: "Issue a daemon enrollment token.",
  },
] as const;

export const API_KEY_COLUMNS = [
  { header: "Name", fill: true },
  { header: "Prefix" },
  { header: "Scopes", fill: true },
  { header: "Actor" },
  { header: "Triggers", fill: true },
  { header: "Created" },
  { header: "Last used" },
  { header: "Status" },
  { header: "", align: "end" as const },
];

const EMPTY_API_KEYS = {
  title: "No API keys",
  description:
    "Create a key to send events, install configuration, start runs, or enroll daemons from automation.",
};

const TRIGGER_LIST_FAILURE =
  "Hub did not receive the trigger list. Check your connection and reload, or enter trigger names below.";

export type ApiKeyTriggerChoices = Snapshot<{ names: string[] }>;
export type ApiKeyWebhookSettings = Snapshot<{ baseUrl: string }>;

export function apiKeyFormPayload(form: FormData) {
  const actor = form.get("actor");
  const names = form
    .getAll("allowedTriggers")
    .flatMap((value) => (typeof value === "string" ? value.split(/[\s,]+/u).filter(Boolean) : []));
  return apiKeyCreateSchema.safeParse({
    name: form.get("name"),
    scopes: form.getAll("scopes"),
    actor: actor === "" ? null : actor,
    allowedTriggers: names.length === 0 ? null : names,
  });
}

export function ApiKeyFormFields({
  name,
  actorOverride,
  scopes,
  triggers,
  scopeError,
  onNameChange,
  onActorChange,
  onScopeChange,
}: {
  name: string;
  actorOverride: string | undefined;
  scopes: readonly ApiKeyScope[];
  triggers: ApiKeyTriggerChoices;
  scopeError: string | undefined;
  onNameChange: (name: string) => void;
  onActorChange: (actor: string) => void;
  onScopeChange: (scope: ApiKeyScope, checked: boolean) => void;
}) {
  return (
    <>
      <FormField
        kind="text"
        id="api-key-name"
        name="name"
        label="Name"
        required
        maxLength={100}
        value={name}
        onChange={onNameChange}
      />
      <FormField
        kind="text"
        id="api-key-actor"
        name="actor"
        label="Actor"
        description="Defaults to a slug of the key name. Use up to 63 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter or number. Required to send events; include this actor in the trigger's from_users."
        value={actorOverride ?? defaultApiKeyActor(name)}
        onChange={onActorChange}
        required={scopes.includes("events:send")}
        pattern={"[a-z0-9][a-z0-9_.\\-]{0,62}"}
        maxLength={63}
      />
      <fieldset className="grid gap-3">
        <legend>Scopes</legend>
        <div className="grid gap-3">
          {SCOPE_OPTIONS.map((option) => (
            <ScopeOption
              key={option.value}
              option={option}
              checked={scopes.includes(option.value)}
              onChange={onScopeChange}
            />
          ))}
        </div>
        {scopeError === undefined ? (
          <FieldDescription>Select at least one scope.</FieldDescription>
        ) : (
          <FieldError>{scopeError}</FieldError>
        )}
      </fieldset>
      <ApiKeyTriggerField triggers={triggers} />
    </>
  );
}

function ScopeOption({
  option,
  checked,
  onChange,
}: {
  option: (typeof SCOPE_OPTIONS)[number];
  checked: boolean;
  onChange: (scope: ApiKeyScope, checked: boolean) => void;
}) {
  const change = useCallback(
    (selected: boolean) => onChange(option.value, selected),
    [onChange, option.value],
  );
  return (
    <CheckboxField
      id={`api-key-scope-${option.value}`}
      name="scopes"
      value={option.value}
      label={option.label}
      description={option.description}
      checked={checked}
      onChange={change}
    />
  );
}

export function ApiKeyTriggerField({ triggers }: { triggers: ApiKeyTriggerChoices }) {
  if (triggers.status === "pending") {
    return (
      <FormField
        kind="text"
        id="api-key-triggers"
        name="allowedTriggers"
        label="Allowed triggers"
        value="Loading triggers..."
        disabled
        description="Leave the selection empty to allow any trigger this actor may reach."
      />
    );
  }
  if (triggers.status === "error") {
    return (
      <>
        <FailureAlert
          title="Triggers unavailable"
          error={triggers.error}
          fallback={TRIGGER_LIST_FAILURE}
        />
        <FormField
          kind="text"
          id="api-key-triggers"
          name="allowedTriggers"
          label="Allowed triggers"
          placeholder="build-finished, deploy-ready"
          description="Enter up to 50 unique trigger names, separated by commas or spaces. Names start with a lowercase letter and contain lowercase letters, numbers, hyphens or underscores. Leave empty to allow any trigger this actor may reach."
        />
      </>
    );
  }
  return (
    <fieldset className="grid gap-3">
      <legend>Allowed triggers</legend>
      <FieldDescription>
        Leave the selection empty to allow any trigger this actor may reach.
      </FieldDescription>
      {triggers.data.names.length === 0 ? (
        <EmptyState
          title="No webhook triggers"
          description="Create a manual.run trigger first to choose it here. You can still create this key now."
        />
      ) : (
        <div className="grid max-h-48 gap-3 overflow-y-auto">
          {triggers.data.names.map((name) => (
            <CheckboxField
              key={name}
              id={`api-key-trigger-${name}`}
              name="allowedTriggers"
              value={name}
              label={name}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function ApiKeyTable({
  records,
  canManage,
  busy,
  onRevoke,
}: {
  records: ApiKeyRecord[];
  canManage: boolean;
  busy: boolean;
  onRevoke: (input: { data: { id: string } }) => void;
}) {
  return (
    <DataTable
      label="API keys"
      columns={API_KEY_COLUMNS}
      isEmpty={records.length === 0}
      empty={EMPTY_API_KEYS}
    >
      {records.map((record) => (
        <ApiKeyRow
          key={record.id}
          record={record}
          canManage={canManage}
          busy={busy}
          onRevoke={onRevoke}
        />
      ))}
    </DataTable>
  );
}

function ApiKeyRow({
  record,
  canManage,
  busy,
  onRevoke,
}: {
  record: ApiKeyRecord;
  canManage: boolean;
  busy: boolean;
  onRevoke: (input: { data: { id: string } }) => void;
}) {
  const revoke = useCallback(() => onRevoke({ data: { id: record.id } }), [onRevoke, record.id]);
  let allowedTriggers = "All";
  if (record.allowedTriggers !== null) {
    allowedTriggers =
      record.allowedTriggers.length === 0 ? "None" : record.allowedTriggers.join(", ");
  }
  return (
    <DataRow>
      <DataCell>{record.name}</DataCell>
      <DataCell>
        <span className="font-mono text-xs">{record.prefix}</span>
      </DataCell>
      <DataCell muted>
        {record.scopes
          .map((scope) => SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope)
          .join(", ")}
      </DataCell>
      <DataCell muted>{record.actor ?? "none"}</DataCell>
      <DataCell muted>{allowedTriggers}</DataCell>
      <DataCell muted>
        <RelativeTime value={record.createdAt} />
      </DataCell>
      <DataCell muted>
        {record.lastUsedAt === null ? "Never" : <RelativeTime value={record.lastUsedAt} />}
      </DataCell>
      <DataCell>
        <StatusPill tone={record.revokedAt === null ? "success" : "danger"}>
          {record.revokedAt === null ? "Active" : "Revoked"}
        </StatusPill>
      </DataCell>
      <DataCell>
        {record.revokedAt === null && canManage ? (
          <RowActions label={`Actions for ${record.name}`}>
            <ConfirmMenuItem
              label="Revoke"
              destructive
              title={`Revoke ${record.name}?`}
              description="Any automation using this key stops working immediately. This cannot be undone."
              confirmLabel="Revoke key"
              cancelLabel="Cancel"
              busy={busy}
              onConfirm={revoke}
            />
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

export function ApiKeySecretContent({
  secret,
  settings,
}: {
  secret: string;
  settings: ApiKeyWebhookSettings;
}) {
  return (
    <>
      <WarningAlert title="Save this key now">
        This secret cannot be recovered after you close this dialog.
      </WarningAlert>
      <CopyField label="Generated API key" value={secret} copyLabel="Copy API key" focusOnMount />
      <ApiKeyWebhookExample settings={settings} />
    </>
  );
}

function ApiKeyWebhookExample({ settings }: { settings: ApiKeyWebhookSettings }) {
  if (settings.status === "pending") {
    return <LoadingLine>Loading webhook address</LoadingLine>;
  }
  if (settings.status === "error") {
    return (
      <FailureAlert
        title="Webhook example unavailable"
        error={settings.error}
        fallback="Hub did not receive the webhook address. Check your connection and reload the page."
      />
    );
  }
  return (
    <>
      <FieldDescription>
        Replace your-trigger-name with a manual.run trigger name and set HUB_KEY to the secret
        above. The key needs the Send events scope.
      </FieldDescription>
      <CopyBlock
        label="Webhook example"
        value={webhookCurl(settings.data.baseUrl, "your-trigger-name")}
        action="Copy curl"
      />
    </>
  );
}
