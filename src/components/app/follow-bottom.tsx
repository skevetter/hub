import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button.js";

export function FollowBottom({
  version,
  children,
  label = "Run timeline",
  maxHeight,
}: {
  version: number;
  children: ReactNode;
  label?: string;
  maxHeight?: string;
}) {
  const height = useMemo(() => (maxHeight === undefined ? undefined : { maxHeight }), [maxHeight]);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  const jump = useCallback(() => {
    const element = viewport.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    following.current = true;
    setBehind(false);
  }, []);
  const scroll = useCallback(() => {
    const element = viewport.current;
    if (element === null) return;
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    if (following.current) setBehind(false);
  }, []);
  useEffect(() => {
    if (following.current) jump();
    else setBehind(true);
  }, [version, jump]);
  return (
    <div className="grid min-w-0 gap-3">
      <div
        ref={viewport}
        onScroll={scroll}
        className={maxHeight === undefined ? "max-h-96 overflow-y-auto" : "overflow-y-auto"}
        style={height}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
      {behind ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={jump}>
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
