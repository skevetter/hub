import { Ellipsis, X } from "lucide-react";
import type { ReactNode } from "react";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet.js";
import { useSidebar } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { useActiveDestination, usePageContext } from "../navigation/index.js";
import { CommandSearchButton } from "./command-menu.js";
import { CrumbLink } from "./crumb-link.js";
import { NavItem, PHONE_TAB_CLASS, type NavigationItem } from "./navigation-group.js";

const PHONE_CRUMB_LINK = "truncate underline-offset-4 hover:underline focus-visible:underline";

export function PhoneHeader({
  scope,
  organizationSlug,
  unavailable = false,
}: {
  scope: string;
  organizationSlug: string;
  /** The URL names a place that did not resolve, so the signed-in organization is not where this is. */
  unavailable?: boolean;
}) {
  return (
    <header className="top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b border-rail-border bg-rail px-4 text-rail-foreground max-md:sticky md:hidden">
      <span
        role="img"
        aria-label="Paseo"
        className="size-5 shrink-0 rounded-sm bg-rail-foreground"
      />
      {unavailable ? (
        <span className="truncate text-sm font-strong">Paseo Hub</span>
      ) : (
        <PhoneTrail scope={scope} organizationSlug={organizationSlug} />
      )}
      <CommandSearchButton phone />
    </header>
  );
}

function PhoneTrail({ scope, organizationSlug }: { scope: string; organizationSlug: string }) {
  const { breadcrumbs } = usePageContext();
  const current = breadcrumbs.at(-1);
  const parents = breadcrumbs.slice(0, -1);
  return (
    <nav aria-label="Breadcrumb" className="grid min-w-0">
      <span className="flex min-w-0 items-center gap-1 text-xs text-rail-muted">
        <CrumbLink to={`/o/${organizationSlug}/home`} className={PHONE_CRUMB_LINK}>
          {scope}
        </CrumbLink>
        {parents.map((entry) => (
          <span key={`${entry.to}:${entry.label}`} className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true">/</span>
            <CrumbLink to={entry.to} className={PHONE_CRUMB_LINK}>
              {entry.label}
            </CrumbLink>
          </span>
        ))}
      </span>
      <span aria-current="page" className="truncate text-sm font-strong">
        {current?.label ?? "Paseo Hub"}
      </span>
    </nav>
  );
}

export function PhoneNavigation({
  items,
  children,
}: {
  items: readonly NavigationItem[];
  children: ReactNode;
}) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const active = useActiveDestination(items);
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-20 grid h-[var(--shell-bottom-bar)] grid-cols-4 border-t border-rail-border bg-rail pb-[var(--shell-bottom-safe-area)] md:hidden"
    >
      {items.map((item) => (
        <NavItem key={item.to} item={item} active={item.to === active} phoneTab />
      ))}
      <Sheet open={isMobile && openMobile} onOpenChange={setOpenMobile}>
        <SheetTrigger className={cn(PHONE_TAB_CLASS, "text-rail-muted hover:bg-rail-accent")}>
          <Ellipsis aria-hidden="true" className="size-4" />
          <span>More</span>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-rail-focus
          className="max-h-svh gap-0 overflow-y-auto border-rail-border bg-rail text-rail-foreground md:hidden"
          style={SHEET_STYLE}
        >
          <SheetHeader className="border-b border-rail-border">
            <SheetTitle className="text-rail-foreground">More</SheetTitle>
            <SheetDescription className="sr-only">Navigation and account</SheetDescription>
          </SheetHeader>
          {children}
          <SheetClose
            aria-label="Close"
            className="absolute top-2 right-2 grid size-11 place-items-center rounded-sm text-rail-muted hover:bg-rail-accent hover:text-rail-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </SheetClose>
        </SheetContent>
      </Sheet>
    </nav>
  );
}

const SHEET_STYLE = { paddingBottom: "env(safe-area-inset-bottom)" };
