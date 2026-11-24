import { useSyncExternalStore, type ReactNode } from "react";

export interface ToastInput {
  title: string;
  description?: string;
  /** A link or button that follows the result, such as View or Undo. */
  action?: ReactNode;
  /** Reusing an id replaces the toast on screen instead of stacking a second one. */
  id?: string;
}

export interface ToastItem extends ToastInput {
  id: string;
}

/** Older toasts leave first, so a burst of saves never stacks more than the reader can read. */
export const MAX_TOASTS = 3;

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
  publish([...items.filter((existing) => existing.id !== id), item].slice(-MAX_TOASTS));
  return id;
}

export function dismissToast(id: string): void {
  if (items.some((item) => item.id === id)) publish(items.filter((item) => item.id !== id));
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
