import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { crumbKey } from "./crumb-labels.js";

type Labels = ReadonlyMap<string, string>;

interface CrumbLabels {
  labels: Labels;
  setLabel: (to: string, label: string | undefined) => void;
}

const NO_LABELS: CrumbLabels = { labels: new Map(), setLabel: () => undefined };
const CrumbLabelsContext = createContext<CrumbLabels>(NO_LABELS);

export function CrumbLabelsProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<Labels>(() => new Map());
  const setLabel = useCallback((to: string, label: string | undefined) => {
    setLabels((current) => {
      if (current.get(to) === label) return current;
      const next = new Map(current);
      if (label === undefined) next.delete(to);
      else next.set(to, label);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ labels, setLabel }), [labels, setLabel]);
  return <CrumbLabelsContext.Provider value={value}>{children}</CrumbLabelsContext.Provider>;
}

export function useCrumbLabels(): Labels {
  return useContext(CrumbLabelsContext).labels;
}

/** Names the crumb for `to` once the page knows what it is showing, such as a record's name. */
export function useCrumbLabel(to: string, label: string | undefined) {
  const { setLabel } = useContext(CrumbLabelsContext);
  useEffect(() => {
    if (label === undefined) return undefined;
    const key = crumbKey(to);
    setLabel(key, label);
    return () => setLabel(key, undefined);
  }, [setLabel, to, label]);
}
