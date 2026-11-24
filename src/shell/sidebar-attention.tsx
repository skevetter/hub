import { Bell } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import { AttentionPanel } from "../attention/attention-panel.js";
import { attentionLabel } from "../attention/client-state.js";
import { useAttention } from "../attention/use-attention.js";
import { AttentionMark } from "../components/app/attention-row.js";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar.js";

export function SidebarAttention() {
  const { isMobile } = useSidebar();
  return isMobile ? null : <AttentionPopover />;
}

function AttentionPopover() {
  const attention = useAttention();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const { count } = attention;
  const close = useCallback(() => setOpen(false), []);
  const focusHeading = useCallback((event: Event) => {
    event.preventDefault();
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            aria-label={attentionLabel(count)}
            className="relative group-data-[collapsible=icon]:justify-center"
          >
            <Bell aria-hidden="true" className="hidden group-data-[collapsible=icon]:block" />
            <span className="group-data-[collapsible=icon]:sr-only">Attention</span>
            {count === 0 ? null : (
              <>
                <span
                  aria-hidden="true"
                  className="tabular-nums group-data-[collapsible=icon]:hidden"
                >
                  {count}
                </span>
                <span className="flex group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-1 group-data-[collapsible=icon]:right-1">
                  <AttentionMark />
                </span>
              </>
            )}
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="right"
          className="w-96 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) overflow-y-auto border-input text-sm"
          aria-labelledby={headingId}
          onOpenAutoFocus={focusHeading}
        >
          <h2 id={headingId} ref={heading} tabIndex={-1} className="font-strong">
            Attention
          </h2>
          <AttentionPanel {...attention} onFollow={close} />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}
