import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

declare module "@tanstack/history" {
  interface HistoryState {
    announceListResults?: true;
  }
}

export const LIST_RESULT_ACTION = { announceListResults: true } as const;

export function useListResultAnnouncement(text: string) {
  const state = useRouterState({ select: ({ resolvedLocation }) => resolvedLocation?.state });
  const key = state?.__TSR_key;
  const seen = useRef(key);
  const [message, setMessage] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (key === undefined || key === seen.current) return;
    const first = seen.current === undefined;
    seen.current = key;
    // Polls update the same location. Use the text from the committed user navigation once.
    setMessage(!first && state?.announceListResults === true ? { key, text } : null);
  }, [key, state?.announceListResults, text]);
  return message;
}
