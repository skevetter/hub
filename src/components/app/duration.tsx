import { useEffect, useState } from "react";

export function formatDuration(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

export function observeElapsedTime(
  startedAt: number,
  update: (now: number) => void,
  visibility: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  > = document,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const now = Date.now();
    update(now);
    const elapsed = now - startedAt;
    let delay = 1000;
    if (elapsed >= 3_600_000) delay = 30_000;
    else if (elapsed >= 60_000) delay = 5000;
    timer = setTimeout(tick, delay);
  };
  const visibilityChanged = () => {
    clearTimeout(timer);
    if (visibility.visibilityState === "visible") tick();
  };
  visibility.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();
  return () => {
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", visibilityChanged);
  };
}

export function Duration({
  startedAt,
  completedAt,
  durationMs,
  running,
}: {
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  running: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const start = Date.parse(startedAt);
  useEffect(() => {
    if (!running) return undefined;
    return observeElapsedTime(start, setNow);
  }, [start, running]);
  const elapsed = durationMs ?? (completedAt === null ? now : Date.parse(completedAt)) - start;
  return <span>{formatDuration(elapsed)}</span>;
}
