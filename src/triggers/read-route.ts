import { triggerSearchSchema, type TriggerSearch } from "./trigger-query.js";

declare module "@tanstack/history" {
  interface HistoryState {
    triggerListSearch?: TriggerSearch;
  }
}

export function legacyTriggerEditorHref(
  { pathname, searchStr }: { pathname: string; searchStr: string },
  triggerId: string,
): string | undefined {
  const search = new URLSearchParams(searchStr);
  const editorSearch = Object.keys(triggerSearchSchema.shape).some((key) => search.has(key));
  if (triggerId !== "new" && !editorSearch) return undefined;
  return `${pathname.replace(/\/$/u, "")}/edit${searchStr}`;
}
