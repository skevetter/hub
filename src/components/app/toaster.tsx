import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { Button } from "../ui/button.js";
import { dismissToast, useToasts, visibleToasts, type ToastItem } from "./toast-store.js";

/** Long enough to read a sentence and reach a View link; hover and focus hold it open. */
export const TOAST_DURATION_MS = 8000;

/** Keyed on the item, so a replacement under the same id gets a fresh timeout. */
function useDismissAfterDelay(item: ToastItem, held: boolean): void {
  useEffect(() => {
    if (held) return undefined;
    const timer = window.setTimeout(() => dismissToast(item.id), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [item, held]);
}

/** A toast stays while the pointer or the keyboard is on it, so a reader is never raced. */
function useHold(onEscape: () => void) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const handlers = useMemo(
    () => ({
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onEscape();
      },
    }),
    [onEscape],
  );
  return { held: hovered || focused, handlers };
}

function ToastCard({ item, returnFocusId }: { item: ToastItem; returnFocusId: string }) {
  const dismiss = useCallback(() => {
    // The card is about to unmount with focus inside it; hand the keyboard back to the page.
    document.getElementById(returnFocusId)?.focus({ preventScroll: true });
    dismissToast(item.id);
  }, [item.id, returnFocusId]);
  const { held, handlers } = useHold(dismiss);
  useDismissAfterDelay(item, held);
  return (
    <div
      data-slot="toast"
      className="pointer-events-auto flex items-start gap-3 rounded-sm border border-input bg-popover p-4 text-popover-foreground shadow-floating"
      {...handlers}
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm font-strong">{item.title}</p>
        {item.description === undefined ? null : (
          <p className="text-sm text-muted-foreground">{item.description}</p>
        )}
        {item.action === undefined ? null : <div className="pt-1 text-sm">{item.action}</div>}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Dismiss: ${item.title}`}
        className="max-md:size-11"
        onClick={dismiss}
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * Where completed actions are confirmed. The polite live region stays mounted and empty so a
 * screen reader hears each toast as it is added. It is a log rather than a status so it never
 * joins the single status region that a page's own message uses. On a phone it sits under the top bar, clear of
 * the bottom bar and the sticky action bar; from `md` it sits at the bottom right.
 */
export function Toaster({ returnFocusId, scope }: { returnFocusId: string; scope: string }) {
  const items = visibleToasts(useToasts(), scope);
  return (
    <div
      data-slot="toaster"
      className="pointer-events-none fixed inset-x-4 top-14 z-40 grid gap-2 md:inset-x-auto md:top-auto md:right-8 md:bottom-8 md:w-96"
    >
      <div role="log" aria-live="polite" aria-label="Notifications" className="grid gap-2">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} returnFocusId={returnFocusId} />
        ))}
      </div>
    </div>
  );
}
