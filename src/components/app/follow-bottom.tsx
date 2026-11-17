import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button.js";

export function FollowBottom({ version, children }: { version: number; children: ReactNode }) {
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
        className="max-h-96 overflow-y-auto"
        role="region"
        aria-label="Run timeline"
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
