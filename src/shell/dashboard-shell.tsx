/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic tenant URLs are assembled from server-resolved route metadata */
import { Cable, Cpu, History, House, MessagesSquare, Settings, Users, Zap } from "lucide-react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, type CSSProperties } from "react";
import { usePageContext } from "../navigation/index.js";
import { Page } from "../components/app/page.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PanelSkeleton } from "../components/app/loading.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
} from "../components/ui/sidebar.js";
import type { ActiveAccountState } from "../auth/organization-contract.js";
import { createOrganization, selectOrganization, signOut } from "../auth/functions.js";
import { ErrorSummary } from "../auth/account-states.js";
import { ActiveAccountProvider } from "../auth/active-account.js";
import type { Result } from "../contract/respond.js";
import { ACCOUNT_MUTATION_KEY, useAccountMutationError } from "../auth/account-mutation.js";
import { useTenantContextMutationPending } from "../auth/tenant-mutation.js";
import { leaveReader } from "../auth/reader-cache.js";
import {
  RouteTenantProvider,
  useOptionalRouteTenant,
  useRouteTenantStatus,
} from "../projects/context.js";
import { SidebarHelp } from "../auth/sidebar-help.js";
import { ExecutionMeter } from "../entitlements/ui/index.js";
import { NavigationGroup, type NavigationItem } from "./navigation-group.js";
import { AccountMenu, OrganizationSwitcher, type RouteTenant } from "./switchers.js";
import { CommandMenuProvider, CommandSearchButton } from "./command-menu.js";
import { PhoneHeader, PhoneNavigation } from "./phone-navigation.js";
import { SiteHeader } from "./site-header.js";
import { CONTENT_ID, SkipLink } from "./skip-link.js";
import { SiteHeaderActionsProvider } from "./site-header-actions.js";

type ActiveAccount = ActiveAccountState;
const SIDEBAR_STYLE: CSSProperties & {
  "--sidebar-width": string;
  "--shell-bottom-safe-area": string;
  "--shell-bottom-bar": string;
} = {
  "--sidebar-width": "14.5rem",
  "--shell-bottom-safe-area": "env(safe-area-inset-bottom)",
  "--shell-bottom-bar": "calc(var(--spacing) * 14 + var(--shell-bottom-safe-area))",
};
type AccountCommandResult = Result<{
  state: "sessionExpired" | "organizationRequired" | "complete";
}>;
type CreateOrganizationCommandResult = Result<{
  state: "sessionExpired" | "complete";
  organizationSlug?: string;
}>;

export function DashboardShell({ account }: { account: ActiveAccount }) {
  const actions = useDashboardAccountActions();
  return (
    <SidebarProvider style={SIDEBAR_STYLE}>
      <RouteTenantProvider>
        <DashboardContent account={account} {...actions} />
      </RouteTenantProvider>
    </SidebarProvider>
  );
}

function useDashboardAccountActions() {
  const navigate = useNavigate();
  const createOrganizationCommand = useAccountCommand(
    useServerFn(createOrganization) as (
      input: Parameters<typeof createOrganization>[0],
    ) => Promise<CreateOrganizationCommandResult>,
  );
  const signOutCommand = useAccountCommand(
    useServerFn(signOut) as (
      input: Parameters<typeof signOut>[0],
    ) => Promise<Result<Record<string, never>>>,
    { signsOut: true },
  );
  const selectOrganizationCommand = useAccountCommand(
    useServerFn(selectOrganization) as (
      input: Parameters<typeof selectOrganization>[0],
    ) => Promise<AccountCommandResult>,
  );
  const create = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: createOrganizationCommand,
    onSuccess: openCreatedOrganization,
  });
  const select = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: ({ input }: { input: Parameters<typeof selectOrganization>[0]; slug: string }) =>
      selectOrganizationCommand(input),
    onSuccess: async (result, variables) => {
      if (result.status === "ok" && result.data.state === "complete") {
        await navigate({
          to: "/o/$organizationSlug/home",
          params: { organizationSlug: variables.slug },
        });
      }
    },
  });
  const leave = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: signOutCommand,
  });
  const tenantContextMutationsPending = useTenantContextMutationPending();
  const tenantContextTransitioning = create.isPending || select.isPending || leave.isPending;
  const failed = useAccountMutationError();
  const createAccount = useCallback((name: string) => create.mutate({ data: { name } }), [create]);
  const selectAccount = useCallback(
    (organizationId: string, slug: string) =>
      select.mutate({ input: { data: { organizationId } }, slug }),
    [select],
  );
  const leaveAccount = useCallback(() => leave.mutate({}), [leave]);
  return {
    busy: tenantContextMutationsPending,
    transitioning: tenantContextTransitioning,
    error: failed,
    onCreateOrganization: createAccount,
    onSelectOrganization: selectAccount,
    onSignOut: leaveAccount,
  };
}

type DashboardContentProps = { account: ActiveAccount } & ReturnType<
  typeof useDashboardAccountActions
>;

function DashboardContent(props: DashboardContentProps) {
  const { account, error, transitioning } = props;
  const tenant = useOptionalRouteTenant() ?? undefined;
  const organization = tenant?.organization ?? account.organization;
  const navigation = organizationNavigation(organization.slug, {
    sessionsEnabled: account.features?.interactiveSessions === true,
    manageResources: tenant?.capabilities.manageResources ?? account.capabilities.manageResources,
  });
  const sidebar = <DashboardSidebar {...props} tenant={tenant} navigation={navigation} />;
  const settings = useMemo(
    () => ({
      slug: organization.slug,
      manageResources: tenant?.capabilities.manageResources ?? account.capabilities.manageResources,
      isInstanceOperator: account.isInstanceOperator,
    }),
    [organization.slug, tenant, account],
  );

  return (
    <CommandMenuProvider
      navigation={navigation}
      settings={settings}
      memberships={account.memberships}
      busy={props.busy}
      onSelectOrganization={props.onSelectOrganization}
    >
      <SkipLink />
      <Sidebar collapsible="icon" data-rail-focus>
        {sidebar}
      </Sidebar>
      <SiteHeaderActionsProvider>
        <SidebarInset className="pb-[var(--shell-bottom-bar)] md:pb-0">
          <PhoneHeader scope={organization.name} />
          <SiteHeader
            scope={organization.name}
            {...(tenant?.project == null ? {} : { project: tenant.project.name })}
          />
          {/* The app's one content inset. Screens never pad themselves. */}
          <div
            id={CONTENT_ID}
            tabIndex={-1}
            className="flex flex-1 flex-col p-4 outline-none md:p-8"
          >
            <Page>
              <ErrorSummary message={error} />
              <PageContent account={account} tenant={tenant} transitioning={transitioning} />
            </Page>
          </div>
        </SidebarInset>
      </SiteHeaderActionsProvider>
      <PhoneNavigation items={navigation.items.slice(0, 3)}>{sidebar}</PhoneNavigation>
    </CommandMenuProvider>
  );
}

function openCreatedOrganization(result: CreateOrganizationCommandResult) {
  if (result.status !== "ok" || result.data.state !== "complete") return;
  const { organizationSlug } = result.data;
  if (organizationSlug !== undefined) window.location.assign(`/o/${organizationSlug}/home`);
}

function useAccountCommand<TInput, TResult extends Result<{ state?: string }>>(
  command: (input: TInput) => Promise<TResult>,
  { signsOut = false }: { signsOut?: boolean } = {},
): (input: TInput) => Promise<TResult> {
  const queryClient = useQueryClient();
  return useCallback(
    async (input: TInput) => {
      const result = await command(input);
      if (result.status !== "ok") return result;
      if (signsOut || result.data.state === "sessionExpired") leaveReader(queryClient);
      else await queryClient.invalidateQueries({ queryKey: ["account"] });
      return result;
    },
    [command, queryClient, signsOut],
  );
}

/**
 * The page slot. Switching organization and resolving the tenant behind a URL both replace what
 * is inside it and nothing else — the sidebar and site header stay put, because the app is not
 * going anywhere while a read is in flight.
 */
function PageContent({
  account,
  tenant,
  transitioning,
}: {
  account: ActiveAccount;
  tenant: RouteTenant | undefined;
  transitioning: boolean;
}) {
  const status = useRouteTenantStatus();
  const page = usePageContext();
  // One name for the slot, whichever read is in flight: switching organization and resolving the
  // tenant behind a URL are the same wait to someone listening to the page.
  if (transitioning || status.state === "pending") {
    // Route metadata says whether the page arriving here is one of the settings sections, and
    // those carry a tab strip above their own header. Holding that rail open is the difference
    // between a page that fills in and a page that drops when the tenant resolves.
    return <PanelSkeleton label="Loading account context" tabs={page.tabs} />;
  }
  if (status.state === "failed") {
    return <FailureAlert title={status.title} error={status.message} fallback={status.message} />;
  }
  return (
    <ActiveAccountProvider account={account}>
      <div key={tenant?.project?.id ?? "organization"}>
        <Outlet />
      </div>
    </ActiveAccountProvider>
  );
}

function DashboardSidebar({
  account,
  tenant,
  busy,
  onCreateOrganization,
  onSelectOrganization,
  onSignOut,
  navigation,
}: Pick<
  DashboardContentProps,
  "account" | "busy" | "onCreateOrganization" | "onSelectOrganization" | "onSignOut"
> & {
  tenant: RouteTenant | undefined;
  navigation: ReturnType<typeof organizationNavigation>;
}) {
  const organization = tenant?.organization ?? account.organization;
  return (
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <OrganizationSwitcher
              account={account}
              organization={organization}
              role={tenant?.membership.role ?? account.membership.role}
              busy={busy}
              onCreateOrganization={onCreateOrganization}
              onSelectOrganization={onSelectOrganization}
            />
          </SidebarMenuItem>
          <SidebarMenuItem className="hidden md:list-item">
            <CommandSearchButton />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavigationGroup label="Organization" {...navigation} />
      </SidebarContent>
      <AccountFooter
        account={account}
        showMeter={tenant !== undefined}
        busy={busy}
        onSignOut={onSignOut}
      />
    </>
  );
}

function AccountFooter({
  account,
  showMeter,
  busy,
  onSignOut,
}: {
  account: ActiveAccount;
  showMeter: boolean;
  busy: boolean;
  onSignOut: () => void;
}) {
  return (
    <SidebarFooter>
      <SidebarMenu>
        {showMeter ? <ExecutionMeter /> : null}
        <SidebarHelp />
        <SidebarMenuItem>
          <AccountMenu
            email={account.account.email}
            name={account.account.name}
            busy={busy}
            onSignOut={onSignOut}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function organizationNavigation(
  slug: string,
  { sessionsEnabled, manageResources }: { sessionsEnabled: boolean; manageResources: boolean },
) {
  const base = `/o/${slug}`;
  const setup =
    sessionsEnabled && manageResources ? SETUP_SECTIONS : SETUP_SECTIONS_WITHOUT_PROFILES;
  return {
    items: destinations(
      base,
      sessionsEnabled ? ORGANIZATION_SECTIONS : ORGANIZATION_SECTIONS_WITHOUT_SESSIONS,
    ),
    setup: destinations(base, setup),
    administration: destinations(base, ORGANIZATION_ADMINISTRATION),
  };
}

interface SectionDestination {
  section: string;
  label: string;
  icon: NavigationItem["icon"];
  subtree?: boolean;
}

function destinations(base: string, sections: readonly SectionDestination[]): NavigationItem[] {
  return sections.map((entry) => ({
    to: `${base}/${entry.section}`,
    label: entry.label,
    icon: entry.icon,
    ...(entry.subtree === undefined ? {} : { subtree: entry.subtree }),
  }));
}

// Where you are, then work, then administration. Home is the landing and says what to do next;
// Team, API keys, Usage, and Billing are configured once and read occasionally, so they sit
// behind Settings rather than competing with the surfaces an operator opens daily, and Settings
// itself sits under a rule: it is where the organization is changed, not where work is done.
const ORGANIZATION_SECTIONS: readonly SectionDestination[] = [
  { section: "home", label: "Home", icon: House },
  { section: "activity", label: "Activity", icon: History },
  { section: "sessions", label: "Sessions", icon: MessagesSquare, subtree: true },
  { section: "triggers", label: "Triggers", icon: Zap, subtree: true },
];
const SETUP_SECTIONS: readonly SectionDestination[] = [
  { section: "daemons", label: "Daemons", icon: Cpu },
  { section: "connections", label: "Connections", icon: Cable },
  { section: "sessions/profiles", label: "Profiles", icon: Users, subtree: true },
];
const ORGANIZATION_ADMINISTRATION: readonly SectionDestination[] = [
  { section: "settings", label: "Settings", icon: Settings, subtree: true },
];
const ORGANIZATION_SECTIONS_WITHOUT_SESSIONS = ORGANIZATION_SECTIONS.filter(
  ({ section }) => section !== "sessions",
);
// Profiles needs sessions and the right to manage resources; the page refuses everyone else.
const SETUP_SECTIONS_WITHOUT_PROFILES = SETUP_SECTIONS.filter(
  ({ section }) => section !== "sessions/profiles",
);
