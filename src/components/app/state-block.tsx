import { cn } from "../../lib/utils.js";
import type { StateTone, StateView } from "./state-label.js";

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
 * The state comes from `state-label.ts`, which names every object's states once.
 */
export function StateBlock({
  state,
  unseen = false,
}: {
  state: StateView;
  /** Nobody has opened this record yet. The block keeps its state and adds "Not opened yet". */
  unseen?: boolean;
}) {
  return (
    <span
      data-slot="state-block"
      className={cn(
        "inline-flex h-7 min-w-24 shrink-0 items-center gap-2 px-2 text-xs font-strong whitespace-nowrap",
        toneStyles[state.tone],
      )}
    >
      {state.label}
      {unseen ? <span className="font-normal">Not opened yet</span> : null}
    </span>
  );
}
