/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic tenant URLs are assembled from server-resolved route metadata */
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";

import { cn } from "../lib/utils.js";
import { usePresentedDestination } from "../navigation/index.js";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../components/ui/sidebar.js";

export interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** The destination owns pages beneath it, so it stays lit while any of them is open. */
  subtree?: boolean;
}

export function NavigationGroup({
  label,
  items,
  administration,
  setup,
}: {
  /** Names the level, e.g. "Organization". Becomes the landmark's accessible name. */
  label: string;
  items: readonly NavigationItem[];
  /** Destinations that change the level rather than work in it, set apart under a rule. */
  administration?: readonly NavigationItem[];
  setup?: readonly NavigationItem[];
}) {
  return (
    <nav aria-label={label}>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((item) => (
              <NavItem key={item.to} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
        {setup === undefined || setup.length === 0 ? null : <SetupGroup items={setup} />}
        {administration === undefined || administration.length === 0 ? null : (
          <>
            <SidebarSeparator className="my-2" />
            <SidebarGroupContent>
              <SidebarMenu>
                {administration.map((item) => (
                  <NavItem key={item.to} item={item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </>
        )}
      </SidebarGroup>
    </nav>
  );
}

function SetupGroup({ items }: { items: readonly NavigationItem[] }) {
  return (
    <>
      <SidebarGroupLabel className="text-rail-muted">Setup</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <NavItem key={item.to} item={item} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </>
  );
}

/**
 * Navigation stays inside the running app. A plain anchor reloads the document, which
 * throws away the resolved account and repaints the pre-auth shell on every hop.
 */
export const PHONE_TAB_CLASS =
  "flex min-h-11 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-sidebar-ring focus-visible:-outline-offset-2";

export function NavItem({ item, phoneTab = false }: { item: NavigationItem; phoneTab?: boolean }) {
  const { to, label, icon: Icon, subtree = false } = item;
  const active = usePresentedDestination(to, subtree);
  const { isMobile, setOpenMobile } = useSidebar();
  // On compact the sidebar is an overlay covering the destination. A document load used
  // to dismiss it; client-side navigation has to dismiss it deliberately.
  const navigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const link = (
    <Link
      to={to as never}
      aria-current={active ? "page" : undefined}
      onClick={navigate}
      className={
        phoneTab
          ? cn(
              PHONE_TAB_CLASS,
              active
                ? "bg-live font-strong text-live-foreground focus-visible:outline-live-foreground"
                : "text-rail-muted hover:bg-rail-accent",
            )
          : undefined
      }
    >
      <Icon aria-hidden="true" className={phoneTab ? "size-4" : undefined} />
      <span>{label}</span>
    </Link>
  );
  if (phoneTab) return link;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={label}
        className="h-9 rounded-sm text-rail-muted hover:bg-sidebar-accent hover:text-sidebar-foreground data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground data-[active=true]:font-strong"
      >
        {link}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
