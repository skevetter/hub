import { Plus } from "lucide-react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, type SyntheticEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
  type DataColumn,
} from "../components/app/data-table.js";
import { PageHeader } from "../components/app/page.js";
import { RowActions } from "../components/app/row-actions.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { Section } from "../components/app/section.js";
import { StatusLine } from "../components/app/status-line.js";
import { StatusPill } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { formValue, invitationRole } from "./account-actions.js";
import { FormField, type FieldControl } from "../components/app/form-field.js";
import { useRouteTenant } from "../projects/context.js";
import type { RouteInput } from "./route-organization.js";
import { useSnapshotQuery } from "../queries/index.js";
import {
  cancelInvitation,
  changeMemberRole,
  createInvitation,
  organizationTeam,
  removeMember,
} from "./functions.js";
import type { Result } from "../contract/respond.js";
import { ACCOUNT_MUTATION_KEY, useAccountMutationPending } from "./account-mutation.js";
import { INVITATION_MUTATION_KEY } from "./tenant-mutation.js";
import type { UsageLimitsView } from "../usage/dashboard.js";
import { atLimit, LockedAction, useOrganizationLimits } from "../entitlements/ui/index.js";

import {
  INVITATION_ROLES,
  ORGANIZATION_ROLES,
  invitationRoleSchema,
  organizationRoleSchema,
  type InvitationRole,
  type OrganizationRole,
  type OrganizationCapabilities,
  type OrganizationTeam,
  type TeamMember,
} from "./organization-contract.js";

type AccountCommandResult = Result<{
  state: "sessionExpired" | "organizationRequired" | "complete";
}>;
const INVITE_FAILURE =
  "Hub did not create the invitation. Check your connection and submit it again.";

const EMPTY_INVITATIONS: NonNullable<OrganizationTeam["invitations"]> = [];
const TEAM_FAILURE = "Hub did not receive the team. Check your connection and reload.";
const INVITATION_ROLE_LABELS = {
  admin: "Admin",
  member: "Member",
} satisfies Record<InvitationRole, string>;
const ORGANIZATION_ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} satisfies Record<OrganizationRole, string>;
/** The organization in the address, with whether a mutation is in flight. */
interface TeamScope {
  id: string;
  slug: string;
  name: string;
  capabilities: OrganizationCapabilities;
  busy: boolean;
}

function teamQueryKey(organizationId: string) {
  return ["organization-team", organizationId] as const;
}

function useRefreshTeam(organizationId: string) {
  const queryClient = useQueryClient();
  return useCallback(() => refreshTeam(queryClient, organizationId), [organizationId, queryClient]);
}

// The active-account read also carries the team (the sessions panel lists participants from it).
async function refreshTeam(queryClient: QueryClient, organizationId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: teamQueryKey(organizationId) }),
    queryClient.invalidateQueries({ queryKey: ["account"] }),
  ]);
}

const MEMBER_COLUMNS: readonly DataColumn[] = [
  { header: "Member", fill: true },
  { header: "Role" },
  { header: "", align: "end" },
];
const MEMBERS_EMPTY = {
  title: "No members",
  description: "This organization has no members yet.",
};
const INVITATION_COLUMNS: readonly DataColumn[] = [
  { header: "Invitee", fill: true },
  { header: "Role" },
  { header: "", align: "end" },
];
const INVITATIONS_EMPTY = {
  title: "No pending invitations",
  description: "New invitations appear here.",
};

export function Team() {
  const tenant = useRouteTenant();
  const { organization, capabilities } = tenant;
  const [inviting, setInviting] = useState(false);
  const invite = useCallback(() => setInviting(true), []);
  const busy = useAccountMutationPending();
  const limits = useOrganizationLimits(capabilities.manageMembers);
  const limit = limits === undefined ? null : inviteLimit(limits);
  const scope = useMemo<TeamScope>(
    () => ({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      capabilities,
      busy,
    }),
    [organization.id, organization.slug, organization.name, capabilities, busy],
  );
  const load = useServerFn(organizationTeam);
  const snapshot = useSnapshotQuery({
    queryKey: teamQueryKey(organization.id),
    queryFn: () => load({ data: { organizationSlug: organization.slug } }),
  });

  return (
    <>
      <PageHeader id="team-heading" title="Team">
        {capabilities.manageMembers && (
          <LockedAction
            limit={limit}
            label="Invite member"
            icon={Plus}
            onPress={invite}
            busy={busy}
          />
        )}
      </PageHeader>
      <TeamContent snapshot={snapshot} scope={scope} />
      {capabilities.manageMembers && (
        <InvitationDialog
          open={inviting}
          onOpenChange={setInviting}
          busy={busy}
          organization={organization}
        />
      )}
    </>
  );
}

function TeamContent({
  snapshot,
  scope,
}: {
  snapshot: ReturnType<typeof useSnapshotQuery<OrganizationTeam>>;
  scope: TeamScope;
}) {
  if (snapshot.status === "pending") {
    return (
      <Section title="Members">
        <DataTableSkeleton label="Members" columns={MEMBER_COLUMNS} />
      </Section>
    );
  }
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Team unavailable"
        error={snapshot.error}
        fallback={TEAM_FAILURE}
        onRetry={snapshot.refetch}
      />
    );
  }
  const { members, invitations } = snapshot.data;
  return (
    <>
      <Section title="Members">
        <MembersTable members={members} scope={scope} />
      </Section>
      {scope.capabilities.manageMembers && (
        <Section title="Pending invitations">
          <InvitationList invitations={invitations ?? EMPTY_INVITATIONS} scope={scope} />
        </Section>
      )}
    </>
  );
}

/**
 * The limit the organization has run into, or null while it may still invite. The flag is
 * reported ahead of the seat cap: an organization with invitations turned off is not short of
 * seats.
 */
function inviteLimit(limits: UsageLimitsView): string | null {
  if (!limits.canInviteMembers) return "Inviting members isn't enabled for this organization.";
  const { seats } = limits;
  if (!atLimit(seats)) return null;
  return `Seat limit reached — ${seats.used} of ${seats.limit} seats are in use.`;
}

function InvitationDialog({
  open,
  onOpenChange,
  busy,
  organization,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  organization: { id: string; slug: string };
}) {
  const [role, setRole] = useState<InvitationRole>(INVITATION_ROLES[1]);
  const create = useCreateInvitation(organization, onOpenChange, setRole);

  const submit = useCallback(
    (event: SyntheticEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      create.mutate({
        data: { email: formValue(data, "email"), role: invitationRole(data) },
      });
    },
    [create],
  );

  const selectRole = useCallback((value: string): void => {
    setRole(invitationRoleSchema.parse(value));
  }, []);

  // A transport failure has no words of its own worth showing; the fallback names what did not
  // happen instead of reporting the browser's own network wording to the reader.
  const failed = create.isError || create.data?.status === "error";

  const roleControl = useCallback(
    (control: FieldControl) => renderInvitationRole(control, role, selectRole),
    [role, selectRole],
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a team member"
      description="Create a role-bound invitation link for a teammate."
      label="Invite team member"
      submitLabel="Create invitation"
      busy={busy || create.isPending}
      onSubmit={submit}
    >
      <FormField label="Invitee email" name="email" id="invite-email" kind="email" required />
      <FormField id="invite-role" label="Role">
        {roleControl}
      </FormField>
      {failed ? (
        <FailureAlert
          title="Invitation not sent"
          error={create.isError ? null : create.data}
          fallback={INVITE_FAILURE}
          focusOnArrival
        />
      ) : null}
    </FormDialog>
  );
}

function useCreateInvitation(
  organization: { id: string; slug: string },
  onOpenChange: (open: boolean) => void,
  setRole: (role: InvitationRole) => void,
) {
  const refresh = useRefreshTeam(organization.id);
  const create = useServerFn(createInvitation) as (
    input: Parameters<typeof createInvitation>[0],
  ) => Promise<AccountCommandResult>;
  // The dialog owns this request. It stays open until the invitation exists, so a refusal — a
  // duplicate address, a seat that just went — is answered where the address was typed, with the
  // address still in the field, instead of closing and reporting itself at the top of the page.
  return useMutation({
    mutationKey: INVITATION_MUTATION_KEY,
    mutationFn: (input: RouteInput<Parameters<typeof createInvitation>[0]>) =>
      create({ data: { ...input.data, organizationSlug: organization.slug } }),
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      await refresh();
      setRole(INVITATION_ROLES[1]);
      onOpenChange(false);
    },
  });
}

function renderInvitationRole(
  control: FieldControl,
  role: InvitationRole,
  selectRole: (role: string) => void,
) {
  return (
    <Select name="role" value={role} onValueChange={selectRole} required>
      <SelectTrigger {...control} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INVITATION_ROLES.map((roleValue) => (
          <SelectItem value={roleValue} key={roleValue}>
            {INVITATION_ROLE_LABELS[roleValue]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MembersTable({ members, scope }: { members: TeamMember[]; scope: TeamScope }) {
  return (
    <DataTable
      label="Members"
      columns={MEMBER_COLUMNS}
      isEmpty={members.length === 0}
      empty={MEMBERS_EMPTY}
    >
      {members.map((member) => (
        <MemberRow scope={scope} member={member} key={member.id} />
      ))}
    </DataTable>
  );
}

function MemberRow({ scope, member }: { scope: TeamScope; member: TeamMember }) {
  const { canManage, changeRole, remove } = useMemberCommands(scope, member);

  return (
    <DataRow>
      <DataCell>
        <TwoLine primary={member.name} secondary={member.email} />
      </DataCell>
      <DataCell>
        {canManage ? (
          <Select
            key={`${member.id}:${member.role}`}
            value={member.role}
            onValueChange={changeRole}
            disabled={scope.busy}
          >
            <SelectTrigger size="sm" aria-label={`Role for ${member.name}`} className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORGANIZATION_ROLES.filter(
                (role) => role !== "owner" || scope.capabilities.manageOwners,
              ).map((role) => (
                <SelectItem value={role} key={role}>
                  {ORGANIZATION_ROLE_LABELS[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <StatusPill tone="neutral" dot={false}>
            {ORGANIZATION_ROLE_LABELS[member.role]}
          </StatusPill>
        )}
      </DataCell>
      <DataCell>
        {canManage ? (
          <RowActions label={`Actions for ${member.name}`}>
            <ConfirmMenuItem
              busy={scope.busy}
              destructive
              label={`Remove ${member.name}`}
              title={`Remove ${member.name}?`}
              description={`${member.name} will immediately lose access to ${scope.name}. This action cannot be undone.`}
              cancelLabel="Keep member"
              confirmLabel={`Remove ${member.name}`}
              onConfirm={remove}
            />
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function useMemberCommands(scope: TeamScope, member: TeamMember) {
  const refresh = useRefreshTeam(scope.id);
  const changeRoleCommand = useServerFn(changeMemberRole) as (
    input: Parameters<typeof changeMemberRole>[0],
  ) => Promise<AccountCommandResult>;
  const removeMemberCommand = useServerFn(removeMember) as (
    input: Parameters<typeof removeMember>[0],
  ) => Promise<AccountCommandResult>;
  const organizationSlug = scope.slug;
  const change = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: (input: RouteInput<Parameters<typeof changeMemberRole>[0]>) =>
      changeRoleCommand({ data: { ...input.data, organizationSlug } }),
    onSuccess: async (result) => {
      if (result.status === "ok") await refresh();
    },
  });
  const removeMemberMutation = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: (input: RouteInput<Parameters<typeof removeMember>[0]>) =>
      removeMemberCommand({ data: { ...input.data, organizationSlug } }),
    onSuccess: async (result) => {
      if (result.status === "ok") await refresh();
    },
  });
  const canManage =
    scope.capabilities.manageMembers &&
    (member.role !== "owner" || scope.capabilities.manageOwners);
  const changeRole = useCallback(
    (value: string) => {
      change.mutate({
        data: { memberId: member.id, role: organizationRoleSchema.parse(value) },
      });
    },
    [change, member.id],
  );
  const remove = useCallback(() => {
    removeMemberMutation.mutate({ data: { memberId: member.id } });
  }, [member.id, removeMemberMutation]);

  return { canManage, changeRole, remove };
}

function InvitationList({
  invitations,
  scope,
}: {
  invitations: NonNullable<OrganizationTeam["invitations"]>;
  scope: TeamScope;
}) {
  const [copyStatus, setCopyStatus] = useState<string>();

  return (
    <>
      <DataTable
        label="Pending invitations"
        columns={INVITATION_COLUMNS}
        isEmpty={invitations.length === 0}
        empty={INVITATIONS_EMPTY}
      >
        {invitations.map((invitation) => (
          <DataRow key={invitation.id}>
            <DataCell>
              <TwoLine primary={invitation.email} />
            </DataCell>
            <DataCell>
              <StatusPill tone="neutral" dot={false}>
                {ORGANIZATION_ROLE_LABELS[invitation.role]}
              </StatusPill>
            </DataCell>
            <DataCell>
              <InvitationActions
                invitation={invitation}
                scope={scope}
                onCopyStatusChange={setCopyStatus}
              />
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
      <StatusLine>{copyStatus}</StatusLine>
    </>
  );
}

function InvitationActions({
  invitation: { id, email, link },
  scope,
  onCopyStatusChange,
}: {
  invitation: { id: string; email: string; link: string };
  scope: TeamScope;
  onCopyStatusChange: (status: string) => void;
}) {
  const refresh = useRefreshTeam(scope.id);
  const cancelCommand = useServerFn(cancelInvitation) as (
    input: Parameters<typeof cancelInvitation>[0],
  ) => Promise<AccountCommandResult>;
  const cancelInvitationMutation = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: (input: RouteInput<Parameters<typeof cancelInvitation>[0]>) =>
      cancelCommand({ data: { ...input.data, organizationSlug: scope.slug } }),
    onSuccess: async (result) => {
      if (result.status === "ok") await refresh();
    },
  });
  const cancel = useCallback(() => {
    cancelInvitationMutation.mutate({ data: { invitationId: id } });
  }, [cancelInvitationMutation, id]);
  const copy = useCallback((): void => {
    void navigator.clipboard.writeText(link).then(
      () => onCopyStatusChange("Invitation link copied."),
      () =>
        onCopyStatusChange(
          "Clipboard access was blocked. Open the invitation menu and copy the link manually.",
        ),
    );
  }, [link, onCopyStatusChange]);

  return (
    <RowActions label={`Actions for ${email}`}>
      <DropdownMenuItem onSelect={copy}>Copy link</DropdownMenuItem>
      <ConfirmMenuItem
        busy={scope.busy}
        destructive
        label="Cancel invitation"
        title={`Cancel invitation for ${email}?`}
        description={`${email} will no longer be able to use this invitation to join ${scope.name}.`}
        cancelLabel="Keep invitation"
        confirmLabel="Cancel invitation"
        onConfirm={cancel}
      />
    </RowActions>
  );
}
