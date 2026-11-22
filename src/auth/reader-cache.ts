import { matchQuery, type QueryClient } from "@tanstack/react-query";
import { accountStateSchema } from "./organization-contract.js";

const accountQuery = { queryKey: ["account"] };

export function resetQueriesOnReaderChange(queryClient: QueryClient): void {
  let reader: string | null | undefined;
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      !matchQuery(accountQuery, event.query)
    ) {
      return;
    }
    const { success, data } = accountStateSchema.safeParse(event.action.data);
    if (!success) return;
    const nextReader = "account" in data ? data.account.id : null;
    const changed = reader !== undefined && reader !== nextReader;
    reader = nextReader;
    if (changed) {
      // The cache listener runs before the batched React notification.
      queryClient.removeQueries({ predicate: (query) => !matchQuery(accountQuery, query) });
    }
  });
}
