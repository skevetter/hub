import { matchQuery, type QueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { accountStateSchema } from "./organization-contract.js";

const accountQuery = { queryKey: ["account"] };
const reloads = new WeakMap<QueryClient, () => void>();
const listeners = new Set<() => void>();
let readerChanged = false;

export const readerChange = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => readerChanged,
};

function reloadDocument() {
  window.location.reload();
}

export function leaveReader(queryClient: QueryClient): void {
  if (readerChanged) return;
  queryClient.removeQueries({ predicate: (query) => !matchQuery(accountQuery, query) });
  // Clear the previous reader's UI before navigation can start.
  flushSync(() => {
    readerChanged = true;
    listeners.forEach((listener) => listener());
  });
  (reloads.get(queryClient) ?? reloadDocument)();
}

export function resetQueriesOnReaderChange(
  queryClient: QueryClient,
  { reload = reloadDocument }: { reload?: () => void } = {},
): void {
  reloads.set(queryClient, reload);
  let reader: string | null | undefined;
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || !matchQuery(accountQuery, event.query)) return;
    // The server also reports schema failures through the query's error channel.
    if (event.action.type === "error" && reader !== undefined) leaveReader(queryClient);
    if (event.action.type !== "success") return;
    const { success, data } = accountStateSchema.safeParse(event.action.data);
    if (!success) {
      if (reader !== undefined) leaveReader(queryClient);
      return;
    }
    const nextReader = "account" in data ? data.account.id : null;
    if (reader !== undefined && reader !== nextReader) leaveReader(queryClient);
    reader = nextReader;
  });
}
