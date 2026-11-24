export interface Confirmation {
  message?: string | undefined;
  outcome?: unknown;
}

/**
 * Runs `show` once per outcome. `emitted` belongs to a component that outlives the one calling
 * this, so a remount or a reworded message for the same outcome stays quiet, while a later
 * outcome with identical copy still confirms.
 */
export function confirmOnce(
  emitted: { current: unknown },
  { message, outcome }: Confirmation,
  show: (message: string) => void,
): void {
  if (message === undefined || outcome === undefined || emitted.current === outcome) return;
  emitted.current = outcome;
  show(message);
}
