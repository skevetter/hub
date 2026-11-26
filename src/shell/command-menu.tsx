import { useRouter } from "@tanstack/react-router";
import { Search } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ActiveAccountState } from "../auth/organization-contract.js";
import { instanceSettingsItems } from "../auth/instance-settings.js";
import {
  useOrganizationSettingsItems,
  type SettingsAccess,
} from "../auth/organization-settings.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command.js";
import { commandActions, matchCommand, pageKeywords } from "./command-entries.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { THEME_OPTIONS, useTheme } from "../theme/index.js";

interface Destination {
  to: string;
  label: string;
}
type Membership = ActiveAccountState["memberships"][number];
interface CommandMenuProps {
  settings: SettingsAccess;
  navigation: { items: readonly Destination[]; setup: readonly Destination[] };
  memberships: readonly Membership[];
  busy: boolean;
  onSelectOrganization: (id: string, slug: string) => void;
}

const CommandMenuOpener = createContext<((opener: HTMLElement | null) => void) | null>(null);
const SHORTCUT = "Cmd/Ctrl+K";

export function CommandMenuProvider({
  children,
  ...commands
}: CommandMenuProps & { children: ReactNode }) {
  const { open, openFrom, setOpen, close, restoreFocus } = useCommandMenuState();
  return (
    <CommandMenuOpener.Provider value={openFrom}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="gap-0 overflow-hidden border-input p-0"
          onCloseAutoFocus={restoreFocus}
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Command menu</DialogTitle>
          <DialogDescription className="sr-only">
            Search pages, settings, actions, organizations, and themes
          </DialogDescription>
          <Command label="Search commands" filter={matchCommand}>
            <CommandInput placeholder="Search commands..." />
            <MenuCommands {...commands} close={close} />
          </Command>
        </DialogContent>
      </Dialog>
    </CommandMenuOpener.Provider>
  );
}

function useCommandMenuState() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openFrom = useCallback((target: HTMLElement | null) => {
    opener.current = target;
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const restoreFocus = useCallback((event: Event) => {
    event.preventDefault();
    opener.current?.focus();
    opener.current = null;
  }, []);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!isCommandShortcut(event)) return;
      event.preventDefault();
      if (open || event.repeat) return;
      const target = document.activeElement;
      openFrom(target instanceof HTMLElement ? target : null);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [open, openFrom]);
  return { open, openFrom, setOpen, close, restoreFocus };
}

function isCommandShortcut(event: KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

export function CommandSearchButton({ phone = false }: { phone?: boolean }) {
  const openFrom = useContext(CommandMenuOpener);
  const open = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => openFrom?.(event.currentTarget),
    [openFrom],
  );
  if (phone) {
    return (
      <button
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        className="ml-auto grid size-11 shrink-0 place-items-center rounded-sm text-rail-foreground hover:bg-rail-accent focus-visible:outline-sidebar-ring"
        onClick={open}
      >
        <Search className="size-4" aria-hidden="true" />
      </button>
    );
  }
  return (
    <SidebarMenuButton
      aria-label="Search"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      tooltip="Search"
      className="h-9 text-rail-muted"
      onClick={open}
    >
      <Search aria-hidden="true" />
      <span>Search</span>
      <kbd className="ml-auto font-mono text-xs group-data-[collapsible=icon]:hidden">
        {SHORTCUT}
      </kbd>
    </SidebarMenuButton>
  );
}

function MenuCommands({
  close,
  navigation,
  settings,
  memberships,
  busy,
  onSelectOrganization,
}: CommandMenuProps & { close: () => void }) {
  const router = useRouter();
  const navigate = useCallback(
    (to: string) => {
      close();
      void router.navigate({ href: to });
    },
    [close, router],
  );
  const selectOrganization = useCallback(
    (id: string, slug: string) => {
      close();
      onSelectOrganization(id, slug);
    },
    [close, onSelectOrganization],
  );

  return (
    <CommandList>
      <CommandEmpty>No matching commands.</CommandEmpty>
      <RouteCommands
        heading="Navigate"
        slug={settings.slug}
        items={navigation.items}
        navigate={navigate}
      />
      <ActionCommands
        settings={settings}
        sessionsEnabled={navigation.items.some(({ to }) => to.endsWith("/sessions"))}
        navigate={navigate}
      />
      <RouteCommands
        heading="Setup"
        slug={settings.slug}
        items={navigation.setup}
        navigate={navigate}
      />
      <SettingsCommands settings={settings} navigate={navigate} />
      <CommandGroup heading="Switch organization">
        {memberships.map((membership) => (
          <OrganizationCommand
            key={membership.id}
            membership={membership}
            disabled={busy}
            select={selectOrganization}
          />
        ))}
      </CommandGroup>
      <ThemeCommands close={close} />
    </CommandList>
  );
}

function SettingsCommands({
  settings,
  navigate,
}: {
  settings: SettingsAccess;
  navigate: (to: string) => void;
}) {
  const items = useOrganizationSettingsItems(settings);
  return (
    <>
      <RouteCommands heading="Settings" slug={settings.slug} items={items} navigate={navigate} />
      {settings.isInstanceOperator ? (
        <RouteCommands
          heading="Instance"
          slug={settings.slug}
          items={instanceSettingsItems(settings.slug)}
          navigate={navigate}
        />
      ) : null}
    </>
  );
}

function ActionCommands({
  settings,
  sessionsEnabled,
  navigate,
}: {
  settings: SettingsAccess;
  sessionsEnabled: boolean;
  navigate: (to: string) => void;
}) {
  const actions = commandActions({
    slug: settings.slug,
    manageResources: settings.manageResources,
    sessionsEnabled,
  });
  if (actions.length === 0) return null;
  return (
    <CommandGroup heading="Actions">
      {actions.map(({ to, label, keywords }) => (
        <RouteCommand
          key={to}
          to={to}
          label={label}
          group="Actions"
          keywords={keywords}
          navigate={navigate}
        />
      ))}
    </CommandGroup>
  );
}

function RouteCommands({
  heading,
  slug,
  items,
  navigate,
}: {
  heading: string;
  slug: string;
  items: readonly Destination[];
  navigate: (to: string) => void;
}) {
  return (
    <CommandGroup heading={heading}>
      {items.map(({ to, label }) => (
        <RouteCommand
          key={to}
          to={to}
          label={label}
          group={heading}
          keywords={pageKeywords(slug, to)}
          navigate={navigate}
        />
      ))}
    </CommandGroup>
  );
}

function RouteCommand({
  to,
  label,
  group,
  keywords,
  navigate,
}: {
  to: string;
  label: string;
  group: string;
  keywords: string[];
  navigate: (to: string) => void;
}) {
  const select = useCallback(() => navigate(to), [to, navigate]);
  return (
    <CommandItem value={`${label} ${group}`} keywords={keywords} onSelect={select}>
      {label}
    </CommandItem>
  );
}

function OrganizationCommand({
  membership,
  disabled,
  select,
}: {
  membership: Membership;
  disabled: boolean;
  select: (id: string, slug: string) => void;
}) {
  const activate = useCallback(() => select(membership.id, membership.slug), [membership, select]);
  return (
    <CommandItem
      value={`${membership.name} switch organization ${membership.slug}`}
      disabled={disabled}
      onSelect={activate}
    >
      {membership.name}
    </CommandItem>
  );
}

function ThemeCommands({ close }: { close: () => void }) {
  const { setChoice } = useTheme();
  const select = useCallback(
    (value: string) => {
      const option = THEME_OPTIONS.find(({ label }) => value === `theme ${label}`);
      if (option === undefined) return;
      setChoice(option.value);
      close();
    },
    [close, setChoice],
  );
  return (
    <CommandGroup heading="Theme">
      {THEME_OPTIONS.map(({ value, label }) => (
        <CommandItem key={value} value={`theme ${label}`} onSelect={select}>
          {label}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
