export const PAGE_SIZES = [15, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];

export function parsePageSize(value: unknown): PageSize | undefined {
  if (value === undefined) return undefined;
  return PAGE_SIZES.find((size) => value === size || value === String(size)) ?? DEFAULT_PAGE_SIZE;
}

function preferenceKey(accountId: string): string {
  return `hub:rows-per-page:${accountId}`;
}

export function readPageSizePreference(accountId: string): PageSize {
  try {
    return (
      parsePageSize(globalThis.localStorage.getItem(preferenceKey(accountId))) ?? DEFAULT_PAGE_SIZE
    );
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

export function rememberPageSize(accountId: string, size: PageSize): void {
  try {
    globalThis.localStorage.setItem(preferenceKey(accountId), String(size));
  } catch {
    // The URL still carries the choice when browser storage is unavailable.
  }
}
