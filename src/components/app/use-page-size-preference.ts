import { useEffect } from "react";
import { DEFAULT_PAGE_SIZE, readPageSizePreference, type PageSize } from "./page-size.js";

export function usePageSizePreference(
  size: PageSize | undefined,
  accountId: string,
  changeSize: (size: PageSize, replace?: boolean) => void,
) {
  useEffect(() => {
    if (size !== undefined) return;
    const remembered = readPageSizePreference(accountId);
    if (remembered !== DEFAULT_PAGE_SIZE) changeSize(remembered, true);
  }, [accountId, changeSize, size]);
}
