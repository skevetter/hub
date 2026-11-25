import { Ellipsis, X } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { AttentionPanel } from "../attention/attention-panel.js";
import { attentionLabel } from "../attention/client-state.js";
import { useAttention } from "../attention/use-attention.js";
import { AttentionMark } from "../components/app/attention-row.js";
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
import { NavItem, PHONE_TAB_CLASS, type NavigationItem } from "./navigation-group.js";

export function PhoneHeader({ scope }: { scope: string }) {
  const { breadcrumbs } = usePageContext();
  return (
    <header className="top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b border-rail-border bg-rail px-4 text-rail-foreground max-md:sticky md:hidden">
      <span
        role="img"
        aria-label="Paseo"
        className="size-5 shrink-0 rounded-sm bg-rail-foreground"
      />
      <nav aria-label="Breadcrumb" className="grid min-w-0">
        <span className="truncate text-xs text-rail-muted">{scope}</span>
        <span aria-current="page" className="truncate text-sm font-strong">
          {breadcrumbs.at(-1) ?? "Paseo Hub"}
        </span>
      </nav>
      <CommandSearchButton phone />
    </header>
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
      className="fixed inset-x-0 bottom-0 z-20 grid h-[var(--shell-bottom-bar)] grid-cols-5 border-t border-rail-border bg-rail pb-[var(--shell-bottom-safe-area)] md:hidden"
    >
      {items.map((item) => (
        <NavItem key={item.to} item={item} active={item.to === active} phoneTab />
      ))}
      {isMobile ? <PhoneAttention /> : null}
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
          <PhoneSheetClose rail />
        </SheetContent>
      </Sheet>
    </nav>
  );
}

function PhoneAttention() {
  const attention = useAttention();
  const { count } = attention;
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const focusHeading = useCallback((event: Event) => {
    event.preventDefault();
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className={cn(PHONE_TAB_CLASS, "text-rail-muted hover:bg-rail-accent")}
        aria-label={attentionLabel(count)}
      >
        <span aria-hidden="true" className="grid size-4 place-items-center">
          {count > 0 ? <AttentionMark /> : null}
        </span>
        <span>Attention</span>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-svh gap-0 overflow-y-auto border-input text-sm md:hidden"
        style={SHEET_STYLE}
        onOpenAutoFocus={focusHeading}
      >
        <SheetHeader className="border-b-2 border-foreground">
          <SheetTitle ref={heading} tabIndex={-1}>
            Attention
          </SheetTitle>
          <SheetDescription className="sr-only">Items that need your attention</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <AttentionPanel {...attention} onFollow={close} />
        </div>
        <PhoneSheetClose />
      </SheetContent>
    </Sheet>
  );
}

function PhoneSheetClose({ rail = false }: { rail?: boolean }) {
  return (
    <SheetClose
      aria-label="Close"
      className={cn(
        "absolute top-2 right-2 grid size-11 place-items-center rounded-sm",
        rail
          ? "text-rail-muted hover:bg-rail-accent hover:text-rail-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <X aria-hidden="true" className="size-4" />
    </SheetClose>
  );
}

const SHEET_STYLE = { paddingBottom: "env(safe-area-inset-bottom)" };
