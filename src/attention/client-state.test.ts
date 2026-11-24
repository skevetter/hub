import { expect, test } from "vitest";
import { attentionLabel, withoutFailedRuns } from "./client-state.js";
import type { AttentionItem } from "./contract.js";

test.each([
  [0, "Attention"],
  [1, "Attention, 1 item"],
  [3, "Attention, 3 items"],
])("names the trigger for %i items", (count, label) => {
  expect(attentionLabel(count)).toBe(label);
});

test("optimistic dismissal only removes failed runs without changing the original snapshot", () => {
  const connection: AttentionItem = {
    id: "connection:github",
    source: "connection",
    title: "GitHub needs authorization",
    detail: "Review authorization.",
    action: { label: "Open connections", to: "/o/acme/connections" },
  };
  const failed: AttentionItem = {
    id: "runs:failed",
    source: "runs",
    title: "1 run failed",
    detail: "Newest: deploy, just now.",
    action: { label: "Review runs", to: "/o/acme/activity", search: { status: "failed" } },
    dismiss: { label: "Mark seen" },
  };
  const generatedAt = "2026-01-01T00:00:00.000Z";
  const snapshot = { items: [failed, connection], generatedAt };

  expect(withoutFailedRuns(snapshot)).toEqual({ items: [connection], generatedAt });
  expect(snapshot.items).toEqual([failed, connection]);
});
