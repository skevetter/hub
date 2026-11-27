/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- focused trigger screens bind one document, and a row's link, timestamp, and action are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useSnapshotQuery } from "../queries/index.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Braces, FileText, LockKeyhole, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { parseDocument } from "yaml";

import { Card } from "../components/app/card.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { CopyButton } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FieldSkeleton, FormField } from "../components/app/form-field.js";
import { ClearListFilters, ListFilters, ListFilterSelect } from "../components/app/list-filters.js";
import { LIST_RESULT_ACTION } from "../components/app/list-result-announcement.js";
import { LoadingLine, Spinner } from "../components/app/loading.js";
import { DEFAULT_PAGE_SIZE, type PageSize } from "../components/app/page-size.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { Pagination } from "../components/app/pagination.js";
import { Steps } from "../components/app/steps.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { StateBlock } from "../components/app/state-block.js";
import { enabledState } from "../components/app/state-label.js";
import { statusLabel } from "../components/app/status-pill.js";
import { toast } from "../components/app/toast-store.js";
import { TwoLine } from "../components/app/two-line.js";
import { usePageSizePreference } from "../components/app/use-page-size-preference.js";
import { Button } from "../components/ui/button.js";
import { SiteHeaderActions } from "../shell/site-header-actions.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { CodeEditor } from "../projects/configuration/code-editor.js";
import { useRouteTenant } from "../projects/context.js";
import type { Result } from "../contract/respond.js";
import {
  newStepFormValue,
  describeTriggerEvent,
  changeTriggerEvent,
  droppedTriggerRules,
  firstStep,
  isManualNoCallers,
  sharedYamlField,
  mergeTriggerForm,
  projectTriggerForm,
  needsActorFilter,
  triggerFormErrors,
  type TriggerFieldErrors,
  type TriggerFormValue,
} from "./configuration/editor.js";
import { describeTriggerYaml, triggerEventClause } from "./configuration/describe.js";
import { hasScriptStep, isShorthandSteps } from "./configuration/editor-steps.js";
import {
  RunLimitField,
  StepBody,
  StepCard,
  StepListFooter,
  useStepRows,
  type StepRows,
} from "./steps-section.js";
import { StepLimitFields, agentStepDescription, type StepAgentProps } from "./step-fields.js";
import {
  fieldError,
  reservedStepIdErrors,
  saveFieldErrors,
  startsAsList,
  yamlListsSteps,
  type TriggerFieldProps,
} from "./step-form-model.js";
import { useDaemonProviderCatalog } from "./use-daemon-provider-catalog.js";
import {
  saveTrigger,
  triggerEditorSnapshot,
  triggerListPage,
  type TriggerSnapshot,
  type TriggerListPage,
} from "./functions.js";
import { savedToast } from "./saved-toast.js";
import { EventFields } from "./event-fields.js";
import { triggerSecondaryLine } from "./script-fields.js";
import { NotificationStatusCard } from "./notification-status-card.js";
import { LastTriggered } from "./last-triggered.js";
import { hasProgressDestination } from "./progress-events.js";
import { WebhookCard } from "./webhook-card.js";
import { IDENTIFIER, TriggerDocumentSchema, TriggerFilterSchema } from "./configuration/schema.js";
import { webhookSettings } from "../webhooks/functions.js";
import {
  EDITOR_EVENTS,
  eventDefinition,
  hasReplyDestination,
  parseEditorEvent,
} from "./configuration/events.js";
import { LIST_PROVIDERS, LIST_PROVIDER_LABELS } from "./list-providers.js";
import {
  TRIGGER_NAME_SEARCH_MAX,
  triggerPageKey,
  triggerSearchSchema,
  type TriggerSearch,
} from "./trigger-query.js";

type BrowserTrigger = TriggerSnapshot["triggers"][number];
interface SaveFailure {
  readonly message: string;
}
type EditorMode = "form" | "yaml";

/** Every form value the operator types into a control, i.e. everything but the event and the switch. */
type TriggerTextField = Exclude<
  {
    [Key in keyof TriggerFormValue]-?: TriggerFormValue[Key] extends string ? Key : never;
  }[keyof TriggerFormValue],
  "event"
>;

const TRIGGER_COLUMNS = [
  { header: "Status", lead: true },
  // From 1280 px the Target column joins and the table has no spare width. Without a floor the
  // shortfall is shared by every flexible column, so a long name or the longest event kind loses
  // a pixel to the font's metrics. The floors make the Target column take the cut instead.
  { header: "Trigger", fill: true, className: "xl:min-w-71" },
  { header: "Event", fill: true, className: "hidden md:table-cell xl:min-w-67" },
  { header: "Target", fill: true, className: "hidden xl:table-cell" },
  { header: "Last triggered", className: "hidden xl:table-cell" },
] as const;

const EVENT_OPTIONS: readonly ComboboxOption[] = EDITOR_EVENTS.map((value) => {
  const { label, provider } = eventDefinition(value);
  return {
    value,
    label,
    detail: value,
    keywords: [label, value],
    icon: <ProviderGlyph provider={provider} />,
  };
});

const LIST_HEADING_ID = "triggers-title";
const LIST_FILTERS_ID = "triggers-filters";
const NO_FILTERED_TRIGGERS = "No triggers match these filters";
const triggerListRoute = getRouteApi("/_shell/o/$organizationSlug/triggers/");
const triggerEditorRoute = getRouteApi("/_shell/o/$organizationSlug/triggers/$triggerId/edit");
const PROVIDER_OPTIONS = LIST_PROVIDERS.map((value) => ({
  value,
  label: LIST_PROVIDER_LABELS[value],
}));
const STATE_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

export function TriggersPanel() {
  const tenant = useRouteTenant();
  const organizationSlug = tenant.organization.slug;
  const search = triggerListRoute.useSearch();
  const navigate = triggerListRoute.useNavigate();
  const load = useServerFn(triggerListPage);
  const snapshot = useSnapshotQuery({
    queryKey: triggerPageKey(organizationSlug, search),
    queryFn: () => load({ data: { organizationSlug, ...search } }),
  });
  const changeSize = useCallback(
    (size: PageSize, replace = false) => {
      void navigate({
        search: (previous) => ({ ...previous, size, cursor: undefined }),
        state: replace ? {} : LIST_RESULT_ACTION,
        replace,
      });
    },
    [navigate],
  );
  usePageSizePreference(search.size, tenant.account.id, changeSize);
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeader title="Triggers" />
        <DataTableSkeleton label="Triggers" columns={TRIGGER_COLUMNS} />
      </>
    );
  }
  if (snapshot.status === "error") {
    return <TriggerLoadError error={snapshot.error} />;
  }
  const data = snapshot.data;
  return (
    <TriggerList
      data={data}
      organizationSlug={organizationSlug}
      search={search}
      accountId={tenant.account.id}
      changeSize={changeSize}
      refreshFailure={snapshot.refreshFailure}
      refetch={snapshot.refetch}
    />
  );
}

interface TriggerListProps {
  data: TriggerListPage;
  organizationSlug: string;
  search: TriggerSearch;
  accountId: string;
  changeSize: (size: PageSize, replace?: boolean) => void;
  refreshFailure: { message: string | null } | null;
  refetch: () => void;
}

function TriggerList({
  data,
  organizationSlug,
  search,
  accountId,
  changeSize,
  refreshFailure,
  refetch,
}: TriggerListProps) {
  const editor = (triggerId: string) => ({
    to: "/o/$organizationSlug/triggers/$triggerId/edit" as const,
    params: { organizationSlug, triggerId },
    search,
  });
  return (
    <>
      <PageHeader id={LIST_HEADING_ID} title="Triggers">
        {data.canManage ? (
          <Button asChild>
            <Link {...editor("new")}>
              <Plus aria-hidden="true" /> New trigger
            </Link>
          </Button>
        ) : null}
      </PageHeader>
      <div className="grid gap-6">
        <TriggerListNotices
          data={data}
          organizationSlug={organizationSlug}
          refreshFailure={refreshFailure}
          refetch={refetch}
        />
        <TriggerListResults
          data={data}
          organizationSlug={organizationSlug}
          search={search}
          accountId={accountId}
          changeSize={changeSize}
        />
      </div>
    </>
  );
}

function TriggerListNotices({
  data,
  organizationSlug,
  refreshFailure,
  refetch,
}: Pick<TriggerListProps, "data" | "organizationSlug" | "refreshFailure" | "refetch">) {
  return (
    <>
      {data.daemons.length === 0 ? (
        <WarningAlert
          title="Add a daemon first"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/o/$organizationSlug/daemons" params={{ organizationSlug }}>
                Go to Daemons
              </Link>
            </Button>
          }
        >
          <p>Triggers need a daemon that can run agents.</p>
        </WarningAlert>
      ) : null}
      {data.notifications === undefined ? null : (
        <NotificationStatusCard status={data.notifications} />
      )}
      {refreshFailure === null ? null : (
        <FailureAlert
          title="Triggers may be out of date"
          error={refreshFailure.message}
          fallback="Hub couldn't refresh this organization's triggers."
          onRetry={refetch}
        />
      )}
    </>
  );
}

function hasTriggerFilters({ state, provider, q }: TriggerSearch): boolean {
  return state !== undefined || provider !== undefined || q !== undefined;
}

function TriggerListResults({
  data,
  organizationSlug,
  search,
  accountId,
  changeSize,
}: Omit<TriggerListProps, "refreshFailure" | "refetch">) {
  const filtered = hasTriggerFilters(search);
  const summary = `${data.triggers.length} ${data.triggers.length === 1 ? "trigger" : "triggers"}`;
  const size = search.size ?? DEFAULT_PAGE_SIZE;
  const announcement = triggerListAnnouncement(
    search,
    size,
    filtered && data.triggers.length === 0 ? NO_FILTERED_TRIGGERS : summary,
  );
  const clear = (
    <ClearListFilters
      target={triggerPageTarget(organizationSlug, { size: search.size })}
      focusId={LIST_FILTERS_ID}
    />
  );
  return (
    <div>
      <TriggerListFilters search={search}>
        {filtered && data.triggers.length > 0 ? clear : null}
      </TriggerListFilters>
      <TriggerListTable
        data={data}
        organizationSlug={organizationSlug}
        search={search}
        filtered={filtered}
        clear={clear}
      />
      <Pagination
        label="Trigger pages"
        position={search.cursor ?? ""}
        fallbackFocusId={LIST_HEADING_ID}
        summary={summary}
        announcement={announcement}
        newer={
          data.previousCursor === null
            ? null
            : triggerPageTarget(organizationSlug, search, data.previousCursor)
        }
        older={
          data.nextCursor === null
            ? null
            : triggerPageTarget(organizationSlug, search, data.nextCursor)
        }
        pageSize={{
          value: size,
          accountId,
          onChange: changeSize,
        }}
        previousLabel="Previous"
        nextLabel="Next"
      />
    </div>
  );
}

function TriggerListTable({
  data,
  organizationSlug,
  search,
  filtered,
  clear,
}: Pick<TriggerListProps, "data" | "organizationSlug" | "search"> & {
  filtered: boolean;
  clear: ReactNode;
}) {
  const read = (triggerId: string) => ({
    to: "/o/$organizationSlug/triggers/$triggerId" as const,
    params: { organizationSlug, triggerId },
    state: { triggerListSearch: search },
  });
  return (
    <DataTable
      label="Triggers"
      columns={TRIGGER_COLUMNS}
      isEmpty={data.triggers.length === 0}
      empty={
        filtered
          ? { title: NO_FILTERED_TRIGGERS, action: clear }
          : {
              title: "No triggers",
              description: "Connect a provider and daemon, then create your first trigger.",
            }
      }
    >
      {data.triggers.map((trigger) => (
        <TriggerListRow key={trigger.id} trigger={trigger} target={read(trigger.id)} />
      ))}
    </DataTable>
  );
}

interface TriggerRowTarget {
  to: "/o/$organizationSlug/triggers/$triggerId";
  params: { organizationSlug: string; triggerId: string };
  state: { triggerListSearch: TriggerSearch };
}

function TriggerListRow({
  trigger,
  target,
}: {
  trigger: BrowserTrigger;
  target: TriggerRowTarget;
}) {
  const navigate = triggerListRoute.useNavigate();
  return (
    <DataRow
      onSelect={() => {
        void navigate(target);
      }}
    >
      <DataCell>
        <StateBlock state={enabledState(trigger.enabled)} />
      </DataCell>
      <DataCell>
        <span className="flex items-center gap-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-foreground"
            role="img"
            aria-label={`${trigger.provider} provider`}
          >
            <ProviderGlyph provider={trigger.provider} />
          </span>
          <TwoLine
            primary={
              <Link
                {...target}
                title={trigger.name}
                className="hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {trigger.name}
              </Link>
            }
            secondary={describeTriggerYaml(trigger.yaml) ?? triggerSecondaryLine(trigger)}
          />
        </span>
      </DataCell>
      <DataCell>
        <TriggerEvent trigger={trigger} />
      </DataCell>
      <DataCell>
        {trigger.draft === null ? (
          <span className="text-muted-foreground">Advanced configuration</span>
        ) : (
          <TwoLine path primary={trigger.draft.daemon} secondary={trigger.draft.cwd} />
        )}
      </DataCell>
      <DataCell>
        <LastTriggered lastTriggered={trigger.lastTriggered} recentRuns={trigger.recentRuns} />
      </DataCell>
    </DataRow>
  );
}

function triggerListAnnouncement(
  { state, provider, q }: TriggerSearch,
  size: PageSize,
  summary: string,
) {
  return [
    summary,
    `Rows per page ${size}`,
    state === undefined ? undefined : `State ${statusLabel(state)}`,
    provider === undefined ? undefined : `Provider ${LIST_PROVIDER_LABELS[provider]}`,
    q === undefined ? undefined : `Name contains ${q}`,
  ]
    .filter((detail) => detail !== undefined)
    .join(". ");
}

function triggerPageTarget(organizationSlug: string, search: TriggerSearch, cursor?: string) {
  return {
    to: "/o/$organizationSlug/triggers" as const,
    params: { organizationSlug },
    search: { ...search, cursor },
  };
}

function TriggerListFilters({ search, children }: { search: TriggerSearch; children: ReactNode }) {
  const navigate = triggerListRoute.useNavigate();
  const [name, setName] = useState(search.q ?? "");
  const nameId = useId();
  useEffect(() => setName(search.q ?? ""), [search.q]);
  const setFilter = (filter: string, value: string) => {
    void navigate({
      state: LIST_RESULT_ACTION,
      search: (previous) =>
        triggerSearchSchema.parse({
          ...previous,
          [filter]: value || undefined,
          cursor: undefined,
        }),
    });
  };
  const change = ({ currentTarget }: ChangeEvent<HTMLSelectElement>) =>
    setFilter(currentTarget.name, currentTarget.value);
  const submit = (event: ChangeEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilter("q", name);
  };
  return (
    <ListFilters id={LIST_FILTERS_ID}>
      <form className="flex min-w-0 items-end gap-2" onSubmit={submit}>
        <FormField
          id={nameId}
          name="q"
          kind="text"
          label="Search triggers"
          value={name}
          maxLength={TRIGGER_NAME_SEARCH_MAX}
          onChange={setName}
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <ListFilterSelect
        name="state"
        label="State"
        allLabel="All states"
        options={STATE_OPTIONS}
        value={search.state}
        onChange={change}
      />
      <ListFilterSelect
        name="provider"
        label="Provider"
        allLabel="All providers"
        options={PROVIDER_OPTIONS}
        value={search.provider}
        onChange={change}
      />
      {children}
    </ListFilters>
  );
}

function TriggerEvent({ trigger }: { trigger: BrowserTrigger }) {
  const { kind, detail } = describeTriggerEvent(trigger.draft, trigger.event);
  return <TwoLine primary={kind} {...(detail === undefined ? {} : { secondary: detail })} />;
}

export function TriggerEditorPanel({ triggerId }: { triggerId: string }) {
  const tenant = useRouteTenant();
  const organizationSlug = tenant.organization.slug;
  const search = triggerEditorRoute.useSearch();
  const load = useServerFn(triggerEditorSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug, "editor", triggerId],
    queryFn: () => load({ data: { organizationSlug, triggerId } }),
  });
  const navigate = triggerEditorRoute.useNavigate();
  const listTarget = triggerPageTarget(organizationSlug, search, search.cursor);
  const queryClient = useQueryClient();
  const saveCommand = useServerFn(saveTrigger) as (input: {
    data: { organizationSlug: string; triggerId?: string; yaml: string };
  }) => Promise<Result<{ state: "complete" }>>;
  const save = useMutation({
    mutationFn: saveCommand,
    onSuccess: async (result, variables) => {
      if (result.status !== "ok") return;
      await queryClient.invalidateQueries({ queryKey: ["triggers", organizationSlug] });
      await navigate(listTarget);
      toast(savedToast(organizationSlug, variables.data.triggerId));
    },
  });
  if (snapshot.status === "pending") return <TriggerEditorSkeleton />;
  if (snapshot.status === "error") {
    return <TriggerLoadError error={snapshot.error} />;
  }
  const data = snapshot.data;
  const trigger = triggerId === "new" ? null : data.triggers.find(({ id }) => id === triggerId);
  if (trigger === undefined) {
    return (
      <FailureAlert
        title="Trigger not found"
        error={null}
        fallback="This trigger no longer exists. Return to the trigger list and choose another one."
      />
    );
  }
  const returnToList = () => void navigate(listTarget);
  return (
    <TriggerEditor
      key={trigger?.id ?? "new"}
      trigger={trigger}
      snapshot={data}
      saving={save.isPending}
      saveFailure={save.data?.status === "error" ? save.data.error : undefined}
      onCancel={returnToList}
      onSave={(yaml) =>
        save.mutate({
          data: {
            organizationSlug,
            ...(trigger?.id === undefined ? {} : { triggerId: trigger.id }),
            yaml,
          },
        })
      }
    />
  );
}

function TriggerLoadError({ error }: { error: string | null }) {
  return (
    <FailureAlert
      title="Triggers unavailable"
      error={error}
      fallback="Hub couldn't load this organization's triggers."
    />
  );
}

interface TriggerEditorProps {
  trigger: BrowserTrigger | null;
  snapshot: TriggerSnapshot;
  saving: boolean;
  saveFailure: SaveFailure | undefined;
  onCancel: () => void;
  onSave: (yaml: string) => void;
}

function TriggerEditor({
  trigger,
  snapshot,
  saving,
  saveFailure,
  onCancel,
  onSave,
}: TriggerEditorProps) {
  const legacy = trigger?.format === "legacy_multistep";
  const editor = useTriggerEditorState({ trigger, snapshot, legacy, saveFailure, onSave });
  const webhook = useMemo(
    () => editorWebhook({ mode: editor.mode, form: editor.form, yaml: editor.yaml }),
    [editor.mode, editor.form, editor.yaml],
  );
  const title = trigger === null ? "New trigger" : trigger.name;
  const submitLabel = triggerSubmitLabel(editor.mode, trigger === null);
  const saveDisabled = saving || !snapshot.canManage || legacy || editor.invalidDocument;
  const modeSwitch = <TriggerEditorModeSwitch editor={editor} legacy={legacy} />;
  return (
    <>
      <TriggerEditorHeader
        modeSwitch={modeSwitch}
        onCancel={onCancel}
        saveDisabled={saveDisabled}
        saving={saving}
        submitLabel={submitLabel}
      />
      <TriggerEditorHeading title={title} editor={editor} onCancel={onCancel} />
      <div className="grid gap-6">
        <TriggerEditorAlerts legacy={legacy} editor={editor} saveError={saveFailure?.message} />
        <div className="sm:hidden">{modeSwitch}</div>
        <form id="trigger-editor-form" noValidate className="grid gap-6" onSubmit={editor.submit}>
          <TriggerEditorFields
            editor={editor}
            snapshot={snapshot}
            triggerId={trigger?.id}
            legacy={legacy}
          />
          {webhook === null ? null : (
            <TriggerWebhookCard
              organizationSlug={snapshot.organization.slug}
              triggerName={webhook.triggerName}
              enabled={webhook.enabled}
            />
          )}
          <FormActions pinned>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveDisabled} aria-busy={saving}>
              {saving ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </FormActions>
        </form>
      </div>
    </>
  );
}

function TriggerEditorHeading({
  title,
  editor,
  onCancel,
}: {
  title: string;
  editor: TriggerEditorState;
  onCancel: () => void;
}) {
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5" onClick={onCancel}>
        <ArrowLeft aria-hidden="true" /> Triggers
      </Button>
      <PageHeader
        title={title}
        status={{
          label: editor.form.enabled ? "Enabled" : "Disabled",
          tone: editor.form.enabled ? "success" : "neutral",
        }}
        {...descriptionProp(editor.description)}
      />
    </>
  );
}

type TriggerEditorState = ReturnType<typeof useTriggerEditorState>;

function editorWebhook({ mode, form, yaml }: Pick<TriggerEditorState, "mode" | "form" | "yaml">) {
  if (mode === "form") {
    return form.event === "manual.run" && IDENTIFIER.test(form.name)
      ? { triggerName: form.name, enabled: form.enabled }
      : null;
  }
  try {
    const parsed = TriggerDocumentSchema.safeParse(parseDocument(yaml).toJS());
    return parsed.success && parsed.data.on["manual.run"] !== undefined
      ? { triggerName: parsed.data.name, enabled: parsed.data.enabled }
      : null;
  } catch {
    return null;
  }
}

function TriggerEditorModeSwitch({
  editor,
  legacy,
}: {
  editor: TriggerEditorState;
  legacy: boolean;
}) {
  // Nor is the YAML view a dead segment. A form that cannot serialise yet is a form with fields
  // to fix, and pressing YAML marks them instead of doing nothing at all. Only the legacy
  // document has a mode that is genuinely unreachable, and its own alert says why.
  const modeOptions: readonly SegmentedOption[] = [
    { value: "form", label: "Form", icon: FileText, disabled: legacy || !editor.canEditAsForm },
    { value: "yaml", label: "YAML", icon: Braces },
  ];
  return (
    <SegmentedControl
      label="Editor mode"
      value={editor.mode}
      options={modeOptions}
      onChange={(value) => editor.switchMode(value === "yaml" ? "yaml" : "form")}
    />
  );
}

function TriggerEditorHeader({
  modeSwitch,
  onCancel,
  saveDisabled,
  saving,
  submitLabel,
}: {
  modeSwitch: ReactNode;
  onCancel: () => void;
  saveDisabled: boolean;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <SiteHeaderActions>
      {modeSwitch}
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Discard
      </Button>
      <Button
        type="submit"
        form="trigger-editor-form"
        size="sm"
        disabled={saveDisabled}
        aria-busy={saving}
      >
        {saving ? <Spinner /> : null}
        {submitLabel}
      </Button>
    </SiteHeaderActions>
  );
}

function TriggerEditorAlerts({
  legacy,
  editor,
  saveError,
}: {
  legacy: boolean;
  editor: TriggerEditorState;
  saveError: string | undefined;
}) {
  return (
    <>
      <TriggerCompatibilityAlert
        legacy={legacy}
        advanced={editor.mode === "yaml" && editor.yamlOnly}
        reason={editor.mode === "yaml" ? editor.blocked : undefined}
      />
      {saveError === undefined ? null : (
        <FailureAlert
          title="Trigger not saved"
          error={saveError}
          fallback="Hub couldn't save this trigger."
        />
      )}
      {editor.mode === "form" ? (
        <TriggerRefusalSummary errors={editor.errors} documentError={editor.documentError} />
      ) : null}
    </>
  );
}

function TriggerEditorFields({
  editor,
  snapshot,
  triggerId,
  legacy,
}: {
  editor: TriggerEditorState;
  snapshot: TriggerSnapshot;
  triggerId: string | undefined;
  legacy: boolean;
}) {
  return editor.mode === "yaml" ? (
    <div className="grid h-160 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate font-mono text-xs">trigger.yaml</span>
        <CopyButton label="Trigger YAML" value={editor.yaml} />
      </div>
      <CodeEditor
        value={editor.yaml}
        language="yaml"
        readOnly={!snapshot.canManage || legacy}
        label="Trigger YAML"
        onChange={editor.setYaml}
      />
    </div>
  ) : (
    <TriggerForm
      form={editor.form}
      errors={editor.fieldErrors}
      triggerId={triggerId}
      snapshot={snapshot}
      yaml={editor.yaml}
      onChange={editor.setForm}
    />
  );
}

function TriggerWebhookCard({
  organizationSlug,
  triggerName,
  enabled,
}: {
  organizationSlug: string;
  triggerName: string;
  enabled: boolean;
}) {
  const load = useServerFn(webhookSettings);
  const settings = useSnapshotQuery({
    queryKey: ["webhooks", "settings", organizationSlug],
    queryFn: () => load(),
  });
  if (settings.status === "pending") {
    return (
      <Card title="Webhook">
        <LoadingLine>Loading webhook address</LoadingLine>
      </Card>
    );
  }
  if (settings.status === "error") {
    return (
      <FailureAlert
        title="Webhook address unavailable"
        error={settings.error}
        fallback="Hub couldn't load the webhook address. Reload the page."
      />
    );
  }
  return (
    <WebhookCard baseUrl={settings.data.baseUrl} triggerName={triggerName} enabled={enabled} />
  );
}

function triggerSubmitLabel(mode: EditorMode, creating: boolean) {
  if (mode === "yaml") return "Save YAML";
  return creating ? "Create trigger" : "Save changes";
}

/**
 * The editor holds one trigger in two representations and keeps them convertible. Whether a
 * conversion is possible is a fact about the document, not an accident discovered when the reader
 * clicks: the unavailable mode is disabled and the reason is on screen, so neither switching nor
 * saving can fail with a surprise.
 */
function useTriggerEditorState({
  trigger,
  snapshot,
  legacy,
  saveFailure,
  onSave,
}: {
  trigger: BrowserTrigger | null;
  snapshot: TriggerSnapshot;
  legacy: boolean;
  saveFailure: SaveFailure | undefined;
  onSave: (yaml: string) => void;
}) {
  const { mode, setMode, yaml, setYaml, form, setForm, initialProjection } =
    useEditorRepresentations(trigger, snapshot, legacy);
  const { submitted, save } = useSubmittedForm(form, onSave);
  const saved = useSavedFieldErrors(saveFailure, form, submitted);
  // What the mode the reader is *not* in would receive. In form mode that is the YAML the form
  // serialises to; in YAML mode it is the form the document projects onto.
  const other = useMemo(
    () => (mode === "form" ? mergeTriggerForm(yaml, form) : projectTriggerForm(yaml)),
    [mode, yaml, form],
  );
  const description = useMemo(
    () => describeEditor({ form, legacy, mode, other, yaml }),
    [form, legacy, mode, other, yaml],
  );
  const blocked = projectionBlock(other);
  // Nothing is marked wrong until the reader asks for something the form cannot do yet: a blank
  // new trigger is not a page of errors, it is a page nobody has filled in. Once they have asked,
  // the marks stay and follow what they type.
  const [refused, setRefused] = useState(false);
  const errors = useMemo(
    () => ({ ...triggerFormErrors(form), ...reservedStepIdErrors(form.steps) }),
    [form],
  );
  const refuse = () => setRefused(true);
  const switchMode = (next: EditorMode) =>
    switchEditorMode(next, { mode, other, setForm, setYaml, setMode, refuse });
  const reservedId = Object.keys(reservedStepIdErrors(form.steps)).length > 0;
  const submit = editorSubmit({ mode, other, yaml, onSave: save, refuse, reservedId });
  return {
    mode,
    yaml,
    form,
    description,
    errors: refused ? errors : NO_FIELD_ERRORS,
    fieldErrors: { ...(refused ? errors : NO_FIELD_ERRORS), ...saved },
    invalidDocument: mode === "form" && other.status === "invalid_document",
    documentError: editorDocumentError({ other, refused, errors, blocked }),
    // Legacy workflows are explained by their own alert; repeating the schema error underneath it
    // would say the same thing twice in less useful words.
    blocked: legacy ? undefined : blocked,
    canEditAsForm: mode === "form" || other.status === "editable",
    yamlOnly: initialProjection.status === "yaml_only",
    setYaml,
    setForm,
    switchMode,
    submit,
  };
}

/**
 * The save check names the step it refuses by its position in the form as it was submitted. That
 * mark goes as soon as the reader changes anything, including while the save is still in flight,
 * and comes back if the same refusal does.
 */
function useSavedFieldErrors(
  failure: SaveFailure | undefined,
  form: TriggerFormValue,
  submitted: { current: TriggerFormValue },
) {
  const [saved, setSaved] = useState<{ errors: TriggerFieldErrors; form: TriggerFormValue }>();
  useEffect(() => {
    setSaved(
      failure === undefined
        ? undefined
        : { errors: saveFieldErrors(failure.message), form: submitted.current },
    );
  }, [failure, submitted]);
  return saved?.form === form ? saved.errors : NO_FIELD_ERRORS;
}

/** The form as it was when Save was pressed, which is what a save refusal speaks about. */
function useSubmittedForm(form: TriggerFormValue, onSave: (yaml: string) => void) {
  const submitted = useRef(form);
  const save = (yaml: string) => {
    submitted.current = form;
    onSave(yaml);
  };
  return { submitted, save };
}

function useEditorRepresentations(
  trigger: BrowserTrigger | null,
  snapshot: TriggerSnapshot,
  legacy: boolean,
) {
  const initialForm = trigger?.draft ?? defaultForm(snapshot);
  const initialYaml = trigger?.yaml ?? "";
  const initialProjection = useMemo(() => projectTriggerForm(initialYaml), [initialYaml]);
  const initialMode =
    trigger === null || (initialProjection.status === "editable" && !legacy) ? "form" : "yaml";
  const [mode, setMode] = useState<EditorMode>(initialMode);
  const [yaml, setYaml] = useState(initialYaml);
  const [form, setForm] = useState<TriggerFormValue>(
    initialProjection.status === "editable" ? initialProjection.value : initialForm,
  );
  return { mode, setMode, yaml, setYaml, form, setForm, initialProjection };
}

function projectionBlock(other: EditorProjection) {
  return other.status === "ok" || other.status === "editable" ? undefined : other.reason;
}

function editorSubmit({
  mode,
  other,
  yaml,
  onSave,
  refuse,
  reservedId,
}: {
  mode: EditorMode;
  other: EditorProjection;
  yaml: string;
  onSave: (yaml: string) => void;
  refuse: () => void;
  reservedId: boolean;
}) {
  return (event: ChangeEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === "yaml") onSave(yaml);
    else if (!reservedId && other.status === "ok") onSave(other.yaml);
    else refuse();
  };
}

type EditorProjection = ReturnType<typeof mergeTriggerForm> | ReturnType<typeof projectTriggerForm>;

function describeEditor({
  form,
  legacy,
  mode,
  other,
  yaml,
}: {
  form: TriggerFormValue;
  legacy: boolean;
  mode: EditorMode;
  other: EditorProjection;
  yaml: string;
}) {
  if (legacy) return undefined;
  if (mode === "yaml") return describeTriggerYaml(yaml);
  if (other.status === "ok" || other.status === "invalid_document") {
    const summary = describeTriggerYaml(other.yaml);
    if (summary !== undefined) return summary;
  }
  return describeUnprojectedEditor(form, yaml);
}

function describeUnprojectedEditor(form: TriggerFormValue, yaml: string) {
  if (yaml !== "") return `When ${triggerEventClause(form.event)}, run the configured action.`;
  const target = form.daemon === "" ? "the selected host" : `host ${form.daemon}`;
  const action =
    firstStep(form).action === "script"
      ? "a script"
      : firstStep(form).agent || "the selected agent";
  return `When ${triggerEventClause(form.event)}, run ${action} on ${target}.`;
}

function switchEditorMode(
  next: EditorMode,
  {
    mode,
    other,
    setForm,
    setYaml,
    setMode,
    refuse,
  }: {
    mode: EditorMode;
    other: EditorProjection;
    setForm: (form: TriggerFormValue) => void;
    setYaml: (yaml: string) => void;
    setMode: (mode: EditorMode) => void;
    refuse: () => void;
  },
): void {
  if (next === mode) return;
  if (other.status === "ok" || other.status === "invalid_document") setYaml(other.yaml);
  else if (other.status === "editable") setForm(other.value);
  else {
    refuse();
    return;
  }
  setMode(next);
  window.scrollTo({ top: 0 });
}

function editorDocumentError({
  other,
  refused,
  errors,
  blocked,
}: {
  other: EditorProjection;
  refused: boolean;
  errors: TriggerFieldErrors;
  blocked: string | undefined;
}) {
  return other.status === "invalid_document" || (refused && Object.keys(errors).length === 0)
    ? blocked
    : undefined;
}

const NO_FIELD_ERRORS: TriggerFieldErrors = {};

/**
 * Everything standing between this form and a saved trigger, said once at the top.
 *
 * The marks beside the fields are only useful to a reader who can already see them: the field
 * in the way may be three sections below the button that was pressed, it is always off screen on
 * a phone, and one of them — the daemon, when the organization has none — has no control on the
 * page to be marked at all. The summary takes the keyboard when it arrives, so pressing a button
 * that cannot do anything yet always answers in the same place.
 */
function TriggerRefusalSummary({
  errors,
  documentError,
}: {
  errors: TriggerFieldErrors;
  documentError: string | undefined;
}) {
  const reasons = documentError === undefined ? Object.values(errors) : [documentError];
  const [first] = reasons;
  if (first === undefined) return null;
  return (
    <FailureAlert
      title="This trigger is not ready to save"
      error={reasons.length === 1 ? first : "Fix these fields and submit again."}
      fallback="This trigger is missing something the document needs."
      details={
        reasons.length === 1 ? undefined : (
          <ul className="grid gap-1">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )
      }
      focusOnArrival
    />
  );
}

/**
 * Why the form view is not available for this document, said once. The `reason` is the schema's
 * own words about the YAML on screen, which is also the reason the Form segment above is
 * disabled — a control that cannot be pressed is explained on the page, not in a tooltip.
 */
function TriggerCompatibilityAlert({
  legacy,
  advanced,
  reason,
}: {
  legacy: boolean;
  advanced: boolean;
  reason: string | undefined;
}) {
  if (!legacy && !advanced && reason === undefined) return null;
  return (
    <WarningAlert title={compatibilityTitle(legacy, advanced)}>
      {legacy ? (
        <p>
          This workflow remains runnable. Copy this YAML and use the migration guide to replace it
          with one self-contained trigger per event. Form editing is disabled.
        </p>
      ) : (
        <p>
          {advanced
            ? "This YAML uses features the form cannot represent. Edit it directly; Hub will preserve every advanced field."
            : "This YAML cannot be edited as a form until it parses against the trigger schema."}
        </p>
      )}
      {legacy || reason === undefined ? null : <p>{reason}</p>}
    </WarningAlert>
  );
}

function compatibilityTitle(legacy: boolean, advanced: boolean): string {
  if (legacy) return "Legacy multi-step workflow";
  return advanced ? "Advanced trigger" : "Form editing unavailable";
}

export function ProgressMessageField({
  event,
  checked,
  hubEnabled,
  disabled,
  description: sharedDescription,
  onChange,
}: {
  event: TriggerFormValue["event"];
  checked: boolean;
  hubEnabled: boolean;
  disabled?: boolean;
  description?: string;
  onChange: (checked: boolean) => void;
}) {
  if (!hasProgressDestination(event)) return null;
  const description =
    "Anyone who can see the source can read the message. It shows only run status, counts, and durations and never includes agent output.";
  return (
    <CheckboxField
      id="trigger-progress-message"
      label="Post live progress at the source"
      description={
        sharedDescription ??
        (hubEnabled ? description : `${description} This Hub has progress messages turned off.`)
      }
      {...(disabled === undefined ? {} : { disabled })}
      checked={checked}
      onChange={onChange}
    />
  );
}

type TriggerEventCardProps = TriggerFieldProps & {
  connections: TriggerSnapshot["connections"];
  progressMessagesEnabled: boolean;
};

function TriggerEventCard({
  form,
  errors,
  connections,
  progressMessagesEnabled,
  onChange,
}: TriggerEventCardProps) {
  const [pendingEvent, setPendingEvent] = useState<TriggerFormValue["event"]>();
  const proposedEvent =
    pendingEvent === undefined ? undefined : changeTriggerEvent(form, pendingEvent);
  const droppedRules = proposedEvent === undefined ? [] : droppedTriggerRules(form, proposedEvent);
  const selectEvent = (event: TriggerFormValue["event"]) => {
    const next = changeTriggerEvent(form, event);
    if (droppedTriggerRules(form, next).length === 0) {
      setPendingEvent(undefined);
      onChange(next);
    } else {
      setPendingEvent(event);
    }
  };
  const closePreview = () => {
    setPendingEvent(undefined);
    document.getElementById("trigger-event")?.focus();
  };
  return (
    <Card title={EDITOR_STEPS.event.title}>
      <TriggerEventSelector
        form={form}
        errors={errors}
        connections={connections}
        onChange={onChange}
        selectEvent={selectEvent}
      />
      {proposedEvent === undefined ? null : (
        <TriggerEventPreview
          proposedEvent={proposedEvent}
          droppedRules={droppedRules}
          closePreview={closePreview}
          onChange={onChange}
        />
      )}
      <TriggerAdvancedFilters form={form} />
      <EventFields value={form} errors={errors} onChange={onChange} />
      <ProgressMessageField
        event={form.event}
        checked={form.progressMessage === true}
        hubEnabled={progressMessagesEnabled}
        {...sharedYamlField(form, "progressMessage")}
        onChange={(progressMessage) => onChange({ ...form, progressMessage })}
      />
      <TriggerReplyField form={form} errors={errors} onChange={onChange} />
    </Card>
  );
}

function TriggerAdvancedFilters({ form }: { form: TriggerFormValue }) {
  const advancedFilters = (form.advancedFilters ?? []).filter((key) =>
    Object.hasOwn(TriggerFilterSchema.shape, key),
  );
  return advancedFilters.length === 0 ? null : (
    <WarningAlert title="Advanced filters">
      <p>Open YAML to edit these filters. Form edits preserve them.</p>
      <ul className="list-disc pl-4">
        {advancedFilters.map((key) => (
          <li key={key}>{key}</li>
        ))}
      </ul>
    </WarningAlert>
  );
}

function TriggerEventSelector({
  form,
  errors,
  onChange,
  connections,
  selectEvent,
}: TriggerFieldProps & {
  connections: TriggerSnapshot["connections"];
  selectEvent: (event: TriggerFormValue["event"]) => void;
}) {
  const { provider, origin } = eventDefinition(form.event);
  const connectionOptions = connections
    .filter((connection) => connection.provider === provider)
    .map((connection) => ({ value: connection.slug, label: connection.label }));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField id="trigger-event" label="When this happens" {...sharedYamlField(form, "event")}>
        {(control) => (
          <Combobox
            {...control}
            value={form.event}
            options={EVENT_OPTIONS}
            placeholder="Select an event"
            empty="No events found."
            onChange={(option) => selectEvent(parseEditorEvent(option.value))}
          />
        )}
      </FormField>
      {origin === "hub" ? null : (
        <FormField
          id="trigger-connection"
          label="Connection"
          description="The organization connection that receives the event."
          required
          {...sharedYamlField(form, "connection")}
          {...fieldError(errors, "connection")}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              value={form.connection}
              options={connectionOptions}
              placeholder="Select a connection"
              empty="No connections found."
              onChange={(option) => onChange({ ...form, connection: option.value })}
            />
          )}
        </FormField>
      )}
    </div>
  );
}

function TriggerEventPreview({
  proposedEvent,
  droppedRules,
  closePreview,
  onChange,
}: {
  proposedEvent: TriggerFormValue;
  droppedRules: ReturnType<typeof droppedTriggerRules>;
  closePreview: () => void;
  onChange: TriggerFieldProps["onChange"];
}) {
  return (
    <>
      <WarningAlert title={`Switch to ${eventDefinition(proposedEvent.event).label}?`}>
        <p>Changing the event removes these rules from the draft.</p>
        <ul className="list-disc pl-4">
          {droppedRules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </WarningAlert>
      <FormActions>
        <Button type="button" variant="ghost" onClick={closePreview}>
          Keep current event
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            closePreview();
            onChange(proposedEvent);
          }}
        >
          Change event
        </Button>
      </FormActions>
    </>
  );
}

function TriggerReplyField({ form, errors, onChange }: TriggerFieldProps) {
  return hasReplyDestination(form.event) ? (
    <CheckboxField
      id="trigger-reply-message"
      label="Post the agent's reply"
      description={
        errors.replyMessage ??
        "After a successful run, the Paseo app posts the final answer on the source Linear issue."
      }
      checked={form.replyMessage === true}
      {...sharedYamlField(form, "replyMessage")}
      onChange={(replyMessage) => onChange({ ...form, replyMessage })}
    />
  ) : null;
}

type TriggerFormProps = TriggerFieldProps & {
  triggerId: string | undefined;
  snapshot: TriggerSnapshot;
  yaml: string;
};

function TriggerForm({ form, errors, triggerId, snapshot, yaml, onChange }: TriggerFormProps) {
  const selectedDaemon = snapshot.daemons.find((daemon) => daemon.slug === form.daemon);
  const hasAgent = form.steps.some((step) => step.action === "prompt");
  const providerCatalog = useDaemonProviderCatalog(
    snapshot.organization.slug,
    hasAgent ? selectedDaemon?.id : undefined,
    form.cwd,
  );
  // Once a trigger lists its steps it keeps listing them, so removing down to one step does not
  // swap the card the reader is editing for a different one.
  const [listed, setListed] = useState(() =>
    startsAsList(form.steps, isShorthandSteps(form.steps) && !yamlListsSteps(yaml)),
  );
  const showList = listed || form.steps.length > 1;
  const rows = useStepRows({ form, errors, onChange, onAdd: () => setListed(true) });
  const fields = { form, errors, onChange };
  const step = {
    ...fields,
    providerCatalog,
    connections: snapshot.connections,
    hasDaemon: selectedDaemon !== undefined,
  };
  return (
    <div className="grid gap-6">
      <TriggerIdentityFields {...fields} triggerId={triggerId} />
      <Steps>
        <TriggerEventCard
          form={form}
          errors={errors}
          connections={snapshot.connections}
          progressMessagesEnabled={snapshot.progressMessagesEnabled}
          onChange={onChange}
        />

        {needsActorFilter(form) ? (
          <AccessCard form={form} errors={errors} onChange={onChange} />
        ) : null}

        <TriggerTargetCard
          {...fields}
          snapshot={snapshot}
          selected={selectedDaemon !== undefined}
          listed={showList}
        />
        {stepCards({ listed: showList, rows, step })}
      </Steps>
      <StepListFooter rows={rows} count={form.steps.length} />
      <TriggerExecutionNote steps={form.steps} />
    </div>
  );
}

/** A plain function, not a component: `Steps` numbers each card it is handed as its own row. */
function stepCards({
  listed,
  rows,
  step,
}: {
  listed: boolean;
  rows: StepRows;
  step: Omit<StepAgentProps, "index"> & { hasDaemon: boolean };
}) {
  if (listed) {
    return step.form.steps.map((_, index) => (
      <StepCard key={rows.keys[index] ?? String(index)} {...step} index={index} rows={rows} />
    ));
  }
  return (
    <Card
      title={EDITOR_STEPS.agent.title}
      {...descriptionProp(
        agentStepDescription(step.form.steps[0]?.action === "script", step.hasDaemon),
      )}
    >
      <StepBody {...step} index={0} />
    </Card>
  );
}

const SCRIPT_NOTE =
  "Hub runs the script in a terminal on your daemon, with the daemon's environment. Keys and sandboxing stay on your compute.";
const AGENT_NOTE =
  "Hub launches the agent on your daemon. Keys, provider configuration, and sandboxing stay on your compute.";
const MIXED_NOTE =
  "Hub runs scripts in a terminal on your daemon and launches agents there. Keys, provider configuration, and sandboxing stay on your compute.";

function executionNote(steps: TriggerFormValue["steps"]): string {
  const scripts = steps.filter((step) => step.action === "script").length;
  if (scripts === 0) return AGENT_NOTE;
  return scripts === steps.length ? SCRIPT_NOTE : MIXED_NOTE;
}

function TriggerExecutionNote({ steps }: { steps: TriggerFormValue["steps"] }) {
  return (
    <Card>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LockKeyhole aria-hidden="true" className="size-4 shrink-0 text-link" />
        {executionNote(steps)}
      </p>
    </Card>
  );
}

function triggerFieldUpdate({ form, onChange }: Pick<TriggerFieldProps, "form" | "onChange">) {
  return <Key extends keyof TriggerFormValue>(key: Key, value: TriggerFormValue[Key]) =>
    onChange({ ...form, [key]: value });
}

function triggerTextField(props: Pick<TriggerFieldProps, "form" | "onChange">) {
  const update = triggerFieldUpdate(props);
  return (key: TriggerTextField) => (value: string) => update(key, value);
}

function TriggerIdentityFields({
  form,
  errors,
  triggerId,
  onChange,
}: TriggerFieldProps & Pick<TriggerFormProps, "triggerId">) {
  const update = triggerFieldUpdate({ form, onChange });
  const text = triggerTextField({ form, onChange });
  return (
    <Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="trigger-name"
          label="Trigger name"
          description="Lowercase identifier with hyphens, for example slack-triage."
          kind="text"
          name="name"
          value={form.name}
          onChange={text("name")}
          required
          {...sharedYamlField(form, "name")}
          {...fieldError(errors, "name")}
        />
        <FormField
          id="trigger-id"
          label="Trigger ID"
          description="Immutable identifier within this organization."
          kind="text"
          name="id"
          value={triggerId ?? "Assigned when saved"}
          disabled
        />
      </div>
      <CheckboxField
        id="trigger-enabled"
        label="Enabled"
        description="A disabled trigger keeps its configuration and stops responding to events."
        checked={form.enabled}
        {...sharedYamlField(form, "enabled")}
        onChange={(checked) => update("enabled", checked)}
      />
    </Card>
  );
}

function TriggerTargetCard({
  form,
  errors,
  snapshot,
  onChange,
  selected,
  listed,
}: Omit<TriggerFormProps, "triggerId" | "yaml"> & { selected: boolean; listed: boolean }) {
  const daemonOptions = snapshot.daemons.map((daemon) => ({
    value: daemon.slug,
    label: daemon.slug,
    detail: daemon.presence,
  }));
  const noDaemons = snapshot.daemons.length === 0;
  return (
    <Card
      title={EDITOR_STEPS.target.title}
      {...(noDaemons
        ? {
            description: NO_DAEMON_DESCRIPTION,
            action: (
              <Button asChild variant="outline" size="sm">
                <Link to={`/o/${snapshot.organization.slug}/daemons` as never}>Go to Daemons</Link>
              </Button>
            ),
          }
        : {})}
    >
      {noDaemons ? null : (
        <>
          <TargetDaemonField
            form={form}
            errors={errors}
            onChange={onChange}
            daemonOptions={daemonOptions}
          />
          {selected ? (
            <TargetRuntimeFields form={form} errors={errors} onChange={onChange} listed={listed} />
          ) : null}
          {selected ? <RunLimitField form={form} errors={errors} onChange={onChange} /> : null}
        </>
      )}
    </Card>
  );
}

function TargetDaemonField({
  form,
  errors,
  onChange,
  daemonOptions,
}: TriggerFieldProps & { daemonOptions: ComboboxOption[] }) {
  return (
    <FormField
      id="trigger-daemon"
      label="Run on daemon"
      required
      {...sharedYamlField(form, "daemon")}
      {...fieldError(errors, "daemon")}
    >
      {(control) => (
        <Combobox
          {...control}
          required
          value={form.daemon}
          options={daemonOptions}
          placeholder="Select a daemon"
          empty="No daemons found."
          onChange={(option) =>
            onChange({
              ...form,
              daemon: option.value,
              steps: form.steps.map((step) => ({
                ...step,
                agent: "",
                mode: "",
                thinkingOptionId: "",
                providerOptions: "",
              })),
            })
          }
        />
      )}
    </FormField>
  );
}

const AGENT_CWD_COPY =
  "Absolute path of the checkout on the daemon, for example /home/you/repo. The agents you can run are read from there.";
const SCRIPT_CWD_COPY =
  "Absolute path on the daemon's host, for example /home/you/repo. It must be an open project in Paseo.";

/** A single step keeps its limits here, with the directory. A list keeps them on each step. */
function TargetRuntimeFields({
  form,
  errors,
  onChange,
  listed,
}: TriggerFieldProps & { listed: boolean }) {
  const text = triggerTextField({ form, onChange });
  const scriptOnly = form.steps.every((step) => step.action === "script");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        id="trigger-cwd"
        label="Working directory"
        description={scriptOnly ? SCRIPT_CWD_COPY : AGENT_CWD_COPY}
        kind="text"
        name="cwd"
        value={form.cwd}
        onChange={text("cwd")}
        required
        {...sharedYamlField(form, "cwd")}
        {...fieldError(errors, "cwd")}
      />
      {listed ? null : (
        <StepLimitFields form={form} errors={errors} onChange={onChange} index={0} />
      )}
    </div>
  );
}

function AccessCard({ form, errors, onChange }: TriggerFieldProps) {
  const script = hasScriptStep(form);
  const { audience } = eventDefinition(form.event);
  const noCallers = isManualNoCallers(form);
  let description: string | undefined;
  if (script) description = SCRIPT_ACCESS_DESCRIPTION;
  else if (audience === "optional")
    description = "Restrict which Linear users can start the run, or leave the list empty.";
  return (
    <Card title={EDITOR_STEPS.access.title} {...descriptionProp(description)}>
      {noCallers ? (
        <WarningAlert title="Nobody can run this trigger">
          <p>The caller list is empty.</p>
        </WarningAlert>
      ) : null}
      <TriggerAudienceFields form={form} errors={errors} onChange={onChange} />
    </Card>
  );
}

function TriggerAudienceFields({ form, errors, onChange }: TriggerFieldProps) {
  const script = hasScriptStep(form);
  const { audience } = eventDefinition(form.event);
  const manual = form.event === "manual.run";
  const chooseAudience = !script && audience === "wildcard";
  const everyone = chooseAudience && form.allowedUsers.trim() === "*";
  const noCallers = isManualNoCallers(form);
  const sharedAudience = sharedYamlField(form, "allowedUsers");
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
      {chooseAudience ? (
        <FormField id="trigger-audience" label="Audience" {...(everyone ? sharedAudience : {})}>
          {() => (
            <SegmentedControl
              label="Audience"
              value={everyone ? "everyone" : "specific"}
              options={sharedAudience.disabled ? SHARED_AUDIENCE_OPTIONS : AUDIENCE_OPTIONS}
              onChange={(value) =>
                onChange({
                  ...form,
                  allowedUsers: value === "everyone" ? "*" : "",
                  manualNoCallers: false,
                })
              }
            />
          )}
        </FormField>
      ) : null}
      {everyone ? null : (
        <FormField
          id="trigger-allowed-users"
          label={manual ? "Caller names" : "User IDs"}
          description={
            manual
              ? "Comma-separated caller names. Use the actor bound to each webhook key or supplied by a manual caller."
              : "Comma-separated provider user IDs."
          }
          kind="text"
          name="allowedUsers"
          value={form.allowedUsers}
          onChange={(value) => onChange({ ...form, allowedUsers: value, manualNoCallers: false })}
          required={!noCallers && (script || audience !== "optional")}
          {...sharedAudience}
          {...fieldError(errors, "allowedUsers")}
        />
      )}
    </div>
  );
}

const AUDIENCE_OPTIONS: readonly SegmentedOption[] = [
  { value: "everyone", label: "Everyone" },
  { value: "specific", label: "Specific people" },
];
const SHARED_AUDIENCE_OPTIONS = AUDIENCE_OPTIONS.map(({ value, label }) => ({
  value,
  label,
  disabled: true,
}));

/**
 * The trigger editor before the snapshot arrives. The back link, the step titles, and the page
 * description are the same every time, so they render for real; only the trigger's own name and
 * field values are placeholders.
 */
function TriggerEditorSkeleton() {
  return (
    <div aria-busy="true">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5" disabled>
        <ArrowLeft aria-hidden="true" /> Triggers
      </Button>
      <PageHeaderSkeleton />
      <div className="grid gap-6">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldSkeleton />
            <FieldSkeleton />
          </div>
        </Card>
        <Steps>
          {Object.values(EDITOR_STEPS).map((step) => (
            <Card key={step.title} title={step.title}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldSkeleton />
                <FieldSkeleton />
              </div>
            </Card>
          ))}
        </Steps>
      </div>
    </div>
  );
}

/**
 * The four decisions a trigger is made of, named once. The form renders them as steps and the
 * skeleton stands in for them, so a reader waiting for a snapshot already sees the shape of the
 * trigger they are about to fill in.
 */
const EDITOR_STEPS = {
  event: {
    title: "The event",
  },
  access: {
    title: "Who can invoke it",
  },
  target: {
    title: "Where it runs",
  },
  agent: {
    title: "What runs there",
  },
} as const;

/** What the step says while the decision above it is still missing. */
const NO_DAEMON_DESCRIPTION =
  "No daemon is connected to this organization yet, and a trigger runs on a daemon.";
const SCRIPT_ACCESS_DESCRIPTION = "A script runs code on your host, so name who may start it.";

function descriptionProp(description: string | undefined) {
  return description === undefined ? {} : { description };
}

/**
 * A new trigger starts from what the organization already has: its Slack workspace, its daemon.
 * The working directory is the one thing nobody but the reader knows — a prefilled path that does
 * not exist on the daemon was accepted as it was, and the first run failed on it — so it stays
 * empty until they type the real one.
 */
function defaultForm(snapshot: TriggerSnapshot): TriggerFormValue {
  const slack = snapshot.connections.find(({ provider }) => provider === "slack");
  const daemon =
    snapshot.daemons.find(({ presence }) => presence === "connected") ?? snapshot.daemons[0];
  return {
    name: "new-trigger",
    enabled: true,
    event: slack === undefined ? "manual.run" : "slack.mention",
    connection: slack?.slug ?? "",
    allowedUsers: "*",
    qualifiers: {},
    daemon: daemon?.slug ?? "",
    cwd: "",
    runMaxRuntime: "",
    steps: [
      newStepFormValue({
        githubDuration: "1h",
        prompt:
          "Handle this request in the originating conversation.\n\nWhen hub.reply is available, use it for useful progress updates and your final user-facing response. Call hub.finish_execution once the request is complete.\n\nRequest:\n${{ paseo.prompt }}",
      }),
    ],
  };
}
