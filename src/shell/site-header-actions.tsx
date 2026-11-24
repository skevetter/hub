import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const SiteHeaderActionsContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function SiteHeaderActionsProvider({ children }: { children: ReactNode }) {
  const target = useRef<HTMLDivElement>(null);
  return (
    <SiteHeaderActionsContext.Provider value={target}>{children}</SiteHeaderActionsContext.Provider>
  );
}

/**
 * Route controls share the desktop header. From `sm` to `md` they get their own row
 * below the phone header. Below `sm` the route puts the controls in the page.
 */
export function SiteHeaderActionsTarget() {
  const target = useContext(SiteHeaderActionsContext);
  if (target === null) throw new Error("site header actions require their provider");
  return <div ref={target} className="ml-auto hidden shrink-0 items-center gap-2 sm:flex" />;
}

export function SiteHeaderActions({ children }: { children: ReactNode }) {
  const target = useContext(SiteHeaderActionsContext);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && target?.current != null ? createPortal(children, target.current) : null;
}
