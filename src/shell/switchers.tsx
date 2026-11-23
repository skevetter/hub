import { Check, LogOut, Plus } from "lucide-react";
import { useCallback, useState, type ComponentProps } from "react";

import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import { ThemeSwitch } from "../components/app/theme-switch.js";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu.js";
import { formValue } from "../auth/account-actions.js";
import type { ActiveAccountState } from "../auth/organization-contract.js";
import type { useOptionalRouteTenant } from "../projects/context.js";
import { SidebarSwitcher } from "./sidebar-switcher.js";

/** The organization, project, and membership behind the URL, once the shell has resolved it. */
export type RouteTenant = NonNullable<ReturnType<typeof useOptionalRouteTenant>>;

type OrganizationSubmit = ComponentProps<typeof FormDialog>["onSubmit"];

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * Switching organization is a choice, not a form submission — picking a membership
 * applies it. Creating one is the low-frequency action at the bottom of the same menu.
 */
export function OrganizationSwitcher({
  account,
  organization,
  role,
  busy,
  onCreateOrganization,
  onSelectOrganization,
}: {
  account: ActiveAccountState;
  organization: { id: string; name: string };
  role: string;
  busy: boolean;
  onCreateOrganization: (name: string) => void;
  onSelectOrganization: (organizationId: string, slug: string) => void;
}) {
  const { creating, setCreating, requestCreate, create } =
    useOrganizationCreation(onCreateOrganization);

  return (
    <>
      <SidebarSwitcher
        label="Organization"
        media={organization.name.trim().charAt(0).toUpperCase()}
        primary={organization.name}
        secondary={ROLE_LABELS[role] ?? role}
      >
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {account.memberships.map((membership) => (
          <OrganizationItem
            key={membership.id}
            id={membership.id}
            name={membership.name}
            slug={membership.slug}
            selected={membership.id === organization.id}
            busy={busy}
            onSelect={onSelectOrganization}
          />
        ))}
        {account.canCreateOrganization ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={requestCreate}>
              <Plus aria-hidden="true" />
              New organization
            </DropdownMenuItem>
          </>
        ) : null}
      </SidebarSwitcher>
      <CreateOrganizationDialog
        open={creating}
        onOpenChange={setCreating}
        busy={busy}
        onSubmit={create}
      />
    </>
  );
}

function useOrganizationCreation(onCreateOrganization: (name: string) => void) {
  const [creating, setCreating] = useState(false);
  const requestCreate = useCallback((event: Event) => {
    event.preventDefault();
    setCreating(true);
  }, []);
  const create: OrganizationSubmit = useCallback(
    (event) => {
      event.preventDefault();
      onCreateOrganization(formValue(new FormData(event.currentTarget), "name"));
      setCreating(false);
    },
    [onCreateOrganization],
  );
  return { creating, setCreating, requestCreate, create };
}

function CreateOrganizationDialog({
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: OrganizationSubmit;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New organization"
      label="Create organization"
      submitLabel="Create organization"
      busy={busy}
      onSubmit={onSubmit}
    >
      <FormField
        id="new-organization-name"
        label="Organization name"
        kind="text"
        name="name"
        required
      />
    </FormDialog>
  );
}

function OrganizationItem({
  id,
  name,
  slug,
  selected,
  busy,
  onSelect,
}: {
  id: string;
  name: string;
  slug: string;
  selected: boolean;
  busy: boolean;
  onSelect: (organizationId: string, slug: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(id, slug);
  }, [id, onSelect, slug]);

  return (
    <DropdownMenuItem
      disabled={busy}
      aria-current={selected ? "true" : undefined}
      data-organization-id={id}
      onSelect={handleSelect}
    >
      <span className="truncate">{name}</span>
      {selected ? <Check aria-hidden="true" className="ml-auto" /> : null}
    </DropdownMenuItem>
  );
}

export function AccountMenu({
  email,
  name,
  busy,
  onSignOut,
}: {
  email: string;
  name: string;
  busy: boolean;
  onSignOut: () => void;
}) {
  return (
    <SidebarSwitcher
      label={email}
      side="top"
      tone="accent"
      media={initials(name, email)}
      primary={name}
      secondary={email}
    >
      <ThemeSwitch />
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={busy} onSelect={onSignOut}>
        <LogOut aria-hidden="true" />
        Sign out
      </DropdownMenuItem>
    </SidebarSwitcher>
  );
}

function initials(name: string, email: string): string {
  const source = name.trim().length > 0 ? name.trim() : email;
  const parts = source.split(/[\s@.]+/u).filter((part) => part.length > 0);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
