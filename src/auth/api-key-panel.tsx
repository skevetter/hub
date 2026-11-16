import { useSnapshotQuery } from "../queries/index.js";
import { KeyRound } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, failureMessage } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import type { Result } from "../contract/respond.js";
import type { ApiKeyScope } from "./api-key-contract.js";
import { createApiKey, listApiKeys, revokeApiKey, revokeCliCredential } from "./functions.js";
import { useActiveAccount } from "./active-account.js";
import { API_KEY_MUTATION_KEY } from "./tenant-mutation.js";
import { triggerSnapshot } from "../triggers/functions.js";
import { webhookSettings } from "../webhooks/functions.js";
import {
  API_KEY_COLUMNS,
  ApiKeyFormFields,
  ApiKeySecretContent,
  ApiKeyTable,
  apiKeyFormPayload,
  type ApiKeyRecord,
  type ApiKeyTriggerChoices,
} from "./api-key-presentation.js";

interface CliCredentialRecord {
  id: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type ListResult = Result<{ keys: ApiKeyRecord[]; cliCredentials: CliCredentialRecord[] }>;
type CreateResult = Result<{ key: ApiKeyRecord; secret: string }>;

/**
 * Every failure on this page names what did not happen, because none of them are recoverable by
 * reading the list: a key that was not issued has no secret to recover, and a key that may or may
 * not have been revoked has to be checked.
 */
const LIST_FAILURE = "Hub did not receive the API-key list. Check your connection and reload.";
const CREATE_FAILURE =
  "Hub did not receive the API-key creation result. Check your connection and reload the key list; no secret can be recovered later.";
const REVOKE_FAILURE =
  "Hub did not receive the API-key revocation result. Check your connection and reload the key list to confirm its status.";

const EMPTY_CLI_TABLE = {
  title: "No CLI logins",
  description: "Run paseo hub login to create one.",
};
const CLI_COLUMNS = [
  { header: "Prefix", fill: true },
  { header: "Created" },
  { header: "Last used" },
  { header: "Status" },
  { header: "", align: "end" as const },
];

const CLI_LOGINS = {
  title: "CLI logins",
  description: "Durable terminal credentials created through browser approval.",
};

export function ApiKeys() {
  const account = useActiveAccount();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string>();
  const load = useServerFn(listApiKeys) as (
    input: Parameters<typeof listApiKeys>[0],
  ) => Promise<ListResult>;
  const snapshot = useSnapshotQuery({
    queryKey: ["api-keys", account.organization.id],
    queryFn: () => load({}),
    enabled: account.capabilities.manageResources,
  });
  const create = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    mutationFn: useServerFn(createApiKey) as (
      input: Parameters<typeof createApiKey>[0],
    ) => Promise<CreateResult>,
    onSuccess: (result) => {
      if (result.status === "ok") setSecret(result.data.secret);
    },
  });
  const revoke = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    mutationFn: useServerFn(revokeApiKey) as (
      input: Parameters<typeof revokeApiKey>[0],
    ) => Promise<Result<Record<string, never>>>,
    onSuccess: async (result) => {
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] });
      }
    },
  });
  const revokeCli = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    mutationFn: useServerFn(revokeCliCredential) as (
      input: Parameters<typeof revokeCliCredential>[0],
    ) => Promise<Result<Record<string, never>>>,
    onSuccess: async (result) => {
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] });
      }
    },
  });
  const openCreate = useCallback(() => setCreating(true), []);
  const reload = snapshot.refetch;
  const close = useCallback(
    (open: boolean) => {
      setCreating(open);
      if (!open) {
        setSecret(undefined);
        create.reset();
        void queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] });
      }
    },
    [account.organization.id, create, queryClient],
  );
  const submit = useCallback(
    (data: Parameters<typeof createApiKey>[0]["data"]) => create.mutate({ data }),
    [create],
  );
  const header = (
    <PageHeader title="API keys" description={`Machine access for ${account.organization.name}.`}>
      <Button asChild variant="outline">
        <a href="https://paseo.sh/docs/hub/api">API reference</a>
      </Button>
      {account.capabilities.manageResources ? (
        <Button type="button" onClick={openCreate}>
          <KeyRound aria-hidden="true" />
          Create API key
        </Button>
      ) : null}
    </PageHeader>
  );
  if (!account.capabilities.manageResources) {
    return (
      <>
        {header}
        <EmptyState
          title="No access to API keys"
          description="You don't have permission to manage API keys."
        />
      </>
    );
  }
  if (snapshot.status === "pending") {
    return (
      <>
        {header}
        <Section>
          <DataTableSkeleton label="API keys" columns={API_KEY_COLUMNS} />
        </Section>
        <Section title={CLI_LOGINS.title} description={CLI_LOGINS.description}>
          <DataTableSkeleton label="CLI logins" columns={CLI_COLUMNS} rows={1} />
        </Section>
      </>
    );
  }
  if (snapshot.status === "error") {
    return (
      <>
        {header}
        <FailureAlert
          title="API keys unavailable"
          error={snapshot.error}
          fallback={LIST_FAILURE}
          onRetry={reload}
        />
      </>
    );
  }
  const keys = [...snapshot.data.keys].sort((left, right) => {
    const revoked = Number(left.revokedAt !== null) - Number(right.revokedAt !== null);
    return revoked || right.createdAt.localeCompare(left.createdAt);
  });
  const cliCredentials = [...snapshot.data.cliCredentials].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const createError =
    create.isError || create.data?.status === "error"
      ? failureMessage(create.data, CREATE_FAILURE)
      : undefined;
  const revokeError =
    revoke.isError || revoke.data?.status === "error"
      ? failureMessage(revoke.data, REVOKE_FAILURE)
      : undefined;
  return (
    <>
      {header}
      <Section>
        {revokeError === undefined ? null : (
          <FailureAlert title="API key not revoked" error={revokeError} fallback={REVOKE_FAILURE} />
        )}
        <ApiKeyTable
          records={keys}
          canManage={account.capabilities.manageResources}
          busy={revoke.isPending}
          onRevoke={revoke.mutate}
        />
      </Section>
      <Section title={CLI_LOGINS.title} description={CLI_LOGINS.description}>
        <DataTable
          label="CLI logins"
          columns={CLI_COLUMNS}
          isEmpty={cliCredentials.length === 0}
          empty={EMPTY_CLI_TABLE}
        >
          {cliCredentials.map((record) => (
            <CliCredentialRow
              key={record.id}
              record={record}
              busy={revokeCli.isPending}
              onRevoke={revokeCli.mutate}
            />
          ))}
        </DataTable>
      </Section>
      <ApiKeyDialog
        key={account.organization.id}
        organizationSlug={account.organization.slug}
        open={creating}
        onOpenChange={close}
        secret={secret}
        busy={create.isPending}
        error={createError}
        onSubmit={submit}
      />
    </>
  );
}

function CliCredentialRow({
  record,
  busy,
  onRevoke,
}: {
  record: CliCredentialRecord;
  busy: boolean;
  onRevoke: (input: { data: { id: string } }) => void;
}) {
  const revoke = useCallback(() => onRevoke({ data: { id: record.id } }), [onRevoke, record.id]);
  return (
    <DataRow>
      <DataCell>
        <span className="font-mono text-xs">{record.prefix}</span>
      </DataCell>
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
        {record.revokedAt === null ? (
          <RowActions label={`Actions for ${record.prefix}`}>
            <ConfirmMenuItem
              label="Revoke"
              destructive
              title="Revoke CLI login?"
              description="This terminal credential stops working immediately."
              confirmLabel="Revoke login"
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

function ApiKeyDialog({
  open,
  organizationSlug,
  onOpenChange,
  secret,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  organizationSlug: string;
  onOpenChange: (open: boolean) => void;
  secret: string | undefined;
  busy: boolean;
  error: string | undefined;
  onSubmit: (data: Parameters<typeof createApiKey>[0]["data"]) => void;
}) {
  const [name, setName] = useState("");
  const [actorOverride, setActorOverride] = useState<string>();
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([]);
  const [scopeError, setScopeError] = useState<string>();
  const [validationError, setValidationError] = useState<string>();
  const loadTriggers = useServerFn(triggerSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => loadTriggers({ data: { organizationSlug } }),
    enabled: open,
  });
  const { data: triggerData, status: triggerStatus, error: triggerError } = snapshot;
  const triggers = useMemo<ApiKeyTriggerChoices>(() => {
    if (triggerStatus === "success") {
      return {
        status: "success",
        data: {
          names: triggerData.triggers
            .filter((trigger) => trigger.event === "manual.run")
            .map((trigger) => trigger.name)
            .sort(),
        },
        error: null,
      };
    }
    if (triggerStatus === "pending") {
      return { status: "pending", data: undefined, error: null };
    }
    return { status: "error", data: undefined, error: triggerError };
  }, [triggerData, triggerError, triggerStatus]);
  const updateScope = useCallback((scope: ApiKeyScope, checked: boolean) => {
    setSelectedScopes((scopes) =>
      checked ? [...scopes, scope] : scopes.filter((value) => value !== scope),
    );
  }, []);
  useEffect(() => {
    if (!open) {
      setName("");
      setActorOverride(undefined);
      setSelectedScopes([]);
      setScopeError(undefined);
      setValidationError(undefined);
    }
  }, [open]);
  // A key with no scopes can do nothing, and the server refuses it. Say so where the choice is
  // rather than greying out the submit, which explains nothing to whoever clicks it.
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (selectedScopes.length === 0) {
        event.preventDefault();
        setScopeError("Select at least one scope.");
        return;
      }
      setScopeError(undefined);
      event.preventDefault();
      const payload = apiKeyFormPayload(new FormData(event.currentTarget));
      if (!payload.success) {
        setValidationError(payload.error.issues.map((issue) => issue.message).join(". "));
        return;
      }
      setValidationError(undefined);
      onSubmit(payload.data);
    },
    [onSubmit, selectedScopes],
  );

  if (secret !== undefined) {
    return <SecretDialog open={open} onOpenChange={onOpenChange} secret={secret} />;
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create API key"
      description="Choose the machine operations this organization key can perform."
      label="Create API key"
      submitLabel="Create API key"
      busy={busy}
      onSubmit={submit}
    >
      <ApiKeyFormFields
        name={name}
        actorOverride={actorOverride}
        scopes={selectedScopes}
        triggers={triggers}
        scopeError={scopeError}
        onNameChange={setName}
        onActorChange={setActorOverride}
        onScopeChange={updateScope}
      />
      {validationError === undefined ? null : (
        <FailureAlert
          title="Check API key details"
          error={validationError}
          fallback="Check the actor and allowed trigger names."
        />
      )}
      {error === undefined ? null : (
        <FailureAlert title="API key not created" error={error} fallback={CREATE_FAILURE} />
      )}
    </FormDialog>
  );
}

/**
 * The key itself, once. The dialog cannot be dismissed by escape or by clicking away while it is
 * on screen, and the value takes focus already selected, because closing it is the one action
 * that destroys the secret for good.
 */
function SecretDialog({
  open,
  onOpenChange,
  secret,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: string;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const preventDismissal = useCallback((event: { preventDefault: () => void }) => {
    event.preventDefault();
  }, []);

  const loadSettings = useServerFn(webhookSettings);
  const settings = useSnapshotQuery({
    queryKey: ["webhook-settings"],
    queryFn: () => loadSettings({}),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={preventDismissal}
        onPointerDownOutside={preventDismissal}
      >
        <DialogHeader>
          <DialogTitle>Copy your API key</DialogTitle>
          <DialogDescription>
            This key is shown once. Store it in your deployment secrets now.
          </DialogDescription>
        </DialogHeader>
        <ApiKeySecretContent secret={secret} settings={settings} />
        <FormActions>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </FormActions>
      </DialogContent>
    </Dialog>
  );
}
