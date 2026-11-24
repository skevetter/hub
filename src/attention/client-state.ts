import type { AttentionSnapshot } from "./contract.js";

export function attentionLabel(count: number): string {
  if (count === 0) return "Attention";
  return `Attention, ${String(count)} ${count === 1 ? "item" : "items"}`;
}

export function withoutFailedRuns(snapshot: AttentionSnapshot): AttentionSnapshot {
  return { ...snapshot, items: snapshot.items.filter(({ id }) => id !== "runs:failed") };
}
