import { cn } from "../../lib/utils.js";

/** Red for needs a person, ultramarine for live, ink for done, grey for off. */
export type StateTone = "attention" | "live" | "done" | "off";

const toneStyles: Record<StateTone, string> = {
  attention: "bg-attention text-attention-foreground",
  live: "bg-live text-live-foreground",
  done: "bg-done text-done-foreground",
  off: "bg-off text-off-foreground",
};

/**
 * The state a record row starts with: a solid square block that carries its own text label, so
 * state never rests on colour alone. It keeps its width on a phone and sits above the record
 * there, never as a full-width bar. Outside a row, show state with `StatusPill`.
 */
export function StateBlock({ tone, children }: { tone: StateTone; children: string }) {
  return (
    <span
      data-slot="state-block"
      className={cn(
        "inline-flex h-7 min-w-24 shrink-0 items-center px-2 text-xs font-strong whitespace-nowrap",
        toneStyles[tone],
      )}
    >
      {children}
    </span>
  );
}
