import { useSnapshotQuery } from "../queries/index.js";
import { KeyRound } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, WarningAlert, failureMessage } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField } from "../components/app/form-field.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
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
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  revokeCliCredential,
  rotateApiKeySigningSecret,
  retireApiKeySigningSecret,
} from "./functions.js";
import { useActiveAccount } from "./active-account.js";
import { API_KEY_MUTATION_KEY } from "./tenant-mutation.js";
import { triggerSnapshot } from "../triggers/functions.js";
import { webhookSettings } from "../webhooks/functions.js";
import {
  API_KEY_COLUMNS,
  ApiKeyFormFields,
  ApiKeySecretContent,
  GitHubSecretContent,
  signingOverlapDeadline,
  type ApiKeyReveal,
  type ApiKeySigningAvailability,
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

type ListResult = Result<{
  keys: ApiKeyRecord[];
  cliCredentials: CliCredentialRecord[];
  signingAvailability: ApiKeySigningAvailability;
}>;
const GITHUB_SIGNER_SCOPES = ["events:send"] as const;
const AUTHENTICATION_OPTIONS = [
  { label: "Bearer token", value: "bearer" },
  { label: "GitHub SHA-256", value: "github" },
];

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
  return <OrganizationApiKeys key={account.organization.id} account={account} />;
}

function OrganizationApiKeys({ account }: { account: ReturnType<typeof useActiveAccount> }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<ApiKeyReveal>();
  const [rotating, setRotating] = useState<ApiKeyRecord>();
  const createKey = useServerFn(createApiKey);
  const rotateKey = useServerFn(rotateApiKeySigningSecret);
  const retireKey = useServerFn(retireApiKeySigningSecret);
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] }),
    [account.organization.id, queryClient],
  );
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
    retry: false,
    mutationFn: async (input: Parameters<typeof createApiKey>[0]) => {
      const result = await createKey(input);
      if (result.status === "error") return result.error.message;
      const issued = result.data;
      setReveal(
        "signingSecret" in issued
          ? {
              signingSecret: issued.signingSecret,
              keyId: issued.key.id,
              trigger: issued.key.allowedTriggers[0],
            }
          : { secret: issued.secret },
      );
      return undefined;
    },
  });
  const rotate = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    retry: false,
    mutationFn: async (input: {
      record: ApiKeyRecord;
      versionId: string;
      overlapSeconds: number;
    }) => {
      const { record, versionId, overlapSeconds } = input;
      const trigger = record.allowedTriggers?.[0];
      if (trigger === undefined) return "Reload the key list to confirm the signing key's trigger.";
      const result = await rotateKey({
        data: { id: record.id, expectedCurrentVersionId: versionId, overlapSeconds },
      });
      if (result.status === "error") return result.error.message;
      setReveal({
        signingSecret: result.data.signingSecret,
        keyId: record.id,
        trigger,
      });
      return undefined;
    },
  });
  const retire = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    retry: false,
    mutationFn: retireKey,
    onSettled: invalidate,
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
      if (!open && create.isPending) return;
      setCreating(open);
      if (!open) {
        setReveal(undefined);
        create.reset();
        void invalidate();
      }
    },
    [create, invalidate],
  );
  const submit = useCallback(
    (data: Parameters<typeof createApiKey>[0]["data"]) => create.mutate({ data }),
    [create],
  );
  const closeRotation = useCallback(
    (open: boolean) => {
      if (open || rotate.isPending) return;
      setRotating(undefined);
      setReveal(undefined);
      rotate.reset();
      void invalidate();
    },
    [invalidate, rotate],
  );
  const submitRotation = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const versionId = rotating?.authentication?.currentVersionId;
      const overlapSeconds = Number(new FormData(event.currentTarget).get("overlapHours")) * 3600;
      if (rotating !== undefined && versionId != null) {
        rotate.mutate({ record: rotating, versionId, overlapSeconds });
      }
    },
    [rotate, rotating],
  );
  const retireVersion = useCallback(
    (id: string, versionId: string) =>
      retire.mutate({ data: { id, expectedPreviousVersionId: versionId } }),
    [retire],
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
  const createError = create.isError ? CREATE_FAILURE : create.data;
  const rotateError = rotate.isError
    ? "Reload the key list before rotating again. A new version may have been issued."
    : rotate.data;
  const retireError =
    retire.isError || retire.data?.status === "error"
      ? failureMessage(
          retire.data,
          "Reload the key list to check whether the previous version was retired.",
        )
      : undefined;
  const revokeError =
    revoke.isError || revoke.data?.status === "error"
      ? failureMessage(revoke.data, REVOKE_FAILURE)
      : undefined;
  let rotationDialog;
  if (rotating !== undefined) {
    rotationDialog =
      reveal === undefined ? (
        <RotationDialog
          record={rotating}
          busy={rotate.isPending}
          error={rotateError}
          onOpenChange={closeRotation}
          onSubmit={submitRotation}
        />
      ) : (
        <SecretDialog open onOpenChange={closeRotation} reveal={reveal} />
      );
  }
  return (
    <>
      {header}
      <Section>
        {revokeError === undefined ? null : (
          <FailureAlert title="API key not revoked" error={revokeError} fallback={REVOKE_FAILURE} />
        )}
        {retireError === undefined ? null : (
          <FailureAlert
            title="Could not confirm retirement"
            error={retireError}
            fallback={retireError}
            onRetry={reload}
          />
        )}
        <ApiKeyTable
          records={keys}
          signingAvailability={snapshot.data.signingAvailability}
          onRotate={setRotating}
          onRetire={retireVersion}
          canManage={account.capabilities.manageResources}
          busy={revoke.isPending || retire.isPending || rotate.isPending}
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
        reveal={creating ? reveal : undefined}
        canSign={snapshot.data.signingAvailability === "enabled"}
        busy={create.isPending}
        error={createError}
        onSubmit={submit}
      />
      {rotationDialog}
    </>
  );
}

function RotationDialog({
  record,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  record: ApiKeyRecord;
  busy: boolean;
  error: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [hours, setHours] = useState("1");
  const deadline = record.authentication?.previousAcceptUntil;
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Rotate signing secret"
      description={`Current version ${record.authentication?.currentVersionId ?? ""}`}
      label="Rotate signing secret"
      submitLabel="Rotate signing secret"
      busy={busy}
      onSubmit={onSubmit}
    >
      {deadline == null ? null : <p>Previous deadline {signingOverlapDeadline(deadline)}</p>}
      <FormField
        kind="number"
        id="signing-overlap-hours"
        name="overlapHours"
        label="Overlap in hours"
        description="Choose 0 to 72 hours. Update GitHub before the overlap ends."
        min={0}
        step={1}
        required
        value={hours}
        onChange={setHours}
        {...(Number(hours) > 72 ? { error: "Use 72 hours or less." } : {})}
      />
      {hours === "0" ? (
        <WarningAlert title="Immediate cutover">
          The current secret stops working as soon as you rotate.
        </WarningAlert>
      ) : null}
      {error === undefined ? null : (
        <FailureAlert title="Rotation needs attention" error={error} fallback={error} />
      )}
    </FormDialog>
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
  reveal,
  canSign,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  organizationSlug: string;
  onOpenChange: (open: boolean) => void;
  reveal: ApiKeyReveal | undefined;
  canSign: boolean;
  busy: boolean;
  error: string | undefined;
  onSubmit: (data: Parameters<typeof createApiKey>[0]["data"]) => void;
}) {
  const [mode, setMode] = useState("bearer");
  const signing = mode === "github";
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
      setMode("bearer");
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
      if (signing && !canSign) {
        event.preventDefault();
        setValidationError(
          "Signature authentication is unavailable. Reload the key list before trying again.",
        );
        return;
      }
      if (!signing && selectedScopes.length === 0) {
        event.preventDefault();
        setScopeError("Select at least one scope.");
        return;
      }
      setScopeError(undefined);
      event.preventDefault();
      const payload = apiKeyFormPayload(new FormData(event.currentTarget), signing);
      if (!payload.success) {
        setValidationError(payload.error.issues.map((issue) => issue.message).join(". "));
        return;
      }
      setValidationError(undefined);
      onSubmit(payload.data);
    },
    [canSign, onSubmit, selectedScopes, signing],
  );

  if (reveal !== undefined) {
    return <SecretDialog open={open} onOpenChange={onOpenChange} reveal={reveal} />;
  }
  const targets =
    triggerStatus === "success"
      ? triggerData.triggers.filter((trigger) => trigger.enabled && trigger.event === "manual.run")
      : [];
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
      {canSign ? (
        <SegmentedControl
          label="Authentication"
          options={AUTHENTICATION_OPTIONS}
          value={mode}
          onChange={setMode}
        />
      ) : null}
      <ApiKeyFormFields
        name={name}
        actorOverride={actorOverride}
        scopes={signing ? GITHUB_SIGNER_SCOPES : selectedScopes}
        triggers={triggers}
        scopeError={scopeError}
        onNameChange={setName}
        onActorChange={setActorOverride}
        onScopeChange={updateScope}
        signingTarget={
          signing ? (
            <>
              <FormField
                id="github-signer-target"
                label="Manual trigger"
                required
                description="This key can send events to this trigger only. Its scope is Send events."
              >
                {(control) => (
                  <Select name="targetTriggerId" required disabled={targets.length === 0}>
                    <SelectTrigger {...control}>
                      <SelectValue placeholder="Select a trigger" />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((target) => (
                        <SelectItem key={target.id} value={target.id}>
                          {target.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              {triggerStatus === "error" && (
                <FailureAlert
                  title="Triggers unavailable"
                  error={triggerError}
                  fallback="Reload the trigger list before creating a GitHub signing key."
                  onRetry={snapshot.refetch}
                />
              )}
              {triggerStatus === "pending" && <p>Loading triggers...</p>}
              {triggerStatus === "success" && targets.length === 0 && (
                <p>Create or enable a manual trigger first.</p>
              )}
              <WarningAlert title="Identical bodies are accepted once per key">
                GitHub signs the body without a timestamp. Hub ignores delivery headers for routing
                and deduplication. A captured body that Hub has never accepted can still arrive
                later.
              </WarningAlert>
            </>
          ) : undefined
        }
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
  reveal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reveal: ApiKeyReveal;
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
          <DialogTitle>
            {"signingSecret" in reveal ? "Copy your GitHub signing secret" : "Copy your API key"}
          </DialogTitle>
          <DialogDescription>
            This key is shown once. Store it in your deployment secrets now.
          </DialogDescription>
        </DialogHeader>
        {"signingSecret" in reveal ? (
          <GitHubSecretContent reveal={reveal} settings={settings} />
        ) : (
          <ApiKeySecretContent secret={reveal.secret} settings={settings} />
        )}
        <FormActions>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </FormActions>
      </DialogContent>
    </Dialog>
  );
}
