import { useSyncExternalStore, type ReactNode } from "react";

export interface ToastInput {
  title: string;
  description?: string;
  /** A link or button that follows the result, such as View or Undo. */
  action?: ReactNode;
  /** Reusing an id replaces the toast on screen instead of stacking a second one. */
  id?: string;
  /** The organization the result belongs to; it is hidden while another one is open. */
  scope?: string;
}

export interface ToastItem extends ToastInput {
  id: string;
}

/** Older toasts leave first, so a burst of saves never stacks more than the reader can read. */
export const MAX_TOASTS = 3;

/** Each organization has its own cap, so a burst in a hidden organization cannot evict a visible toast. */
function withinCap(all: readonly ToastItem[], scope: string | undefined): readonly ToastItem[] {
  const own = all.filter((item) => item.scope === scope);
  if (own.length <= MAX_TOASTS) return all;
  const dropped = new Set(own.slice(0, own.length - MAX_TOASTS).map(({ id }) => id));
  return all.filter(({ id }) => !dropped.has(id));
}

const NONE: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
let items: readonly ToastItem[] = NONE;
let counter = 0;

function publish(next: readonly ToastItem[]): void {
  items = next;
  for (const listener of listeners) listener();
}

/** Shows a confirmation for a completed action and returns its id. */
export function toast(input: ToastInput): string {
  counter += 1;
  const id = input.id ?? `toast-${counter}`;
  const item: ToastItem = { ...input, id };
  publish(withinCap([...items.filter((existing) => existing.id !== id), item], item.scope));
  return id;
}

export function dismissToast(id: string): void {
  if (items.some((item) => item.id === id)) publish(items.filter((item) => item.id !== id));
}

export function visibleToasts(all: readonly ToastItem[], scope: string): readonly ToastItem[] {
  return all.filter((item) => item.scope === undefined || item.scope === scope).slice(-MAX_TOASTS);
}

export function clearToasts(): void {
  if (items.length > 0) publish(NONE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toastSnapshot(): readonly ToastItem[] {
  return items;
}

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, toastSnapshot, () => NONE);
}
