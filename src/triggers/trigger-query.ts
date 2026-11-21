import { z } from "zod";
import { DEFAULT_PAGE_SIZE, parsePageSize } from "../components/app/page-size.js";
import { LIST_PROVIDERS } from "./list-providers.js";

export const TRIGGER_NAME_SEARCH_MAX = 100;

const triggerNameSearch = z
  .string()
  .trim()
  .max(TRIGGER_NAME_SEARCH_MAX)
  .refine((value) => !value.includes("\u0000"))
  .toLowerCase()
  .transform((value) => value || undefined);

function searchText(value: unknown): unknown {
  // The router decodes bare query values as JSON before validation.
  return typeof value === "number" || typeof value === "boolean" || value === null
    ? String(value)
    : value;
}

export const triggerSearchSchema = z.object({
  state: z.enum(["enabled", "disabled"]).optional().catch(undefined),
  provider: z.enum(LIST_PROVIDERS).optional().catch(undefined),
  q: z.preprocess(searchText, triggerNameSearch.optional()).catch(undefined),
  size: z.unknown().transform(parsePageSize).optional(),
  cursor: z.string().min(1).optional().catch(undefined),
});

export type TriggerSearch = z.output<typeof triggerSearchSchema>;

export function triggerPageKey(organizationSlug: string, search: TriggerSearch) {
  return [
    "triggers",
    organizationSlug,
    "page",
    { ...search, size: search.size ?? DEFAULT_PAGE_SIZE },
  ] as const;
}
