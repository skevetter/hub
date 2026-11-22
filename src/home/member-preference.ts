import { useCallback, useEffect, useState } from "react";

/**
 * A yes or no this member chose on this browser, e.g. a card they minimized. Hub has no table for
 * per-member interface choices, so the browser holds it; a browser that refuses storage simply
 * forgets, which costs the member one click.
 */
export function readMemberFlag(key: string): boolean | undefined {
  try {
    const stored = globalThis.localStorage.getItem(key);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

export function rememberMemberFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // The choice still holds for this visit.
  }
}

export function memberFlagKey(name: string, organizationId: string, accountId: string): string {
  return `hub:${name}:${organizationId}:${accountId}`;
}

/**
 * The stored choice is read after mount: the server cannot see it, and a first client render
 * that disagreed with the server's would be a hydration mismatch.
 */
export function useMemberFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const stored = readMemberFlag(key);
    if (stored !== undefined) setValue(stored);
  }, [key]);
  const change = useCallback(
    (next: boolean) => {
      setValue(next);
      rememberMemberFlag(key, next);
    },
    [key],
  );
  return [value, change];
}
