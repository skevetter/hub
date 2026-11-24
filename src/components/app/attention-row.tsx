import type { ReactNode } from "react";
import { Skeleton } from "../ui/skeleton.js";

const ROW_CLASS =
  "grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-border py-3 last:border-b-0";

export function AttentionMark() {
  return <span aria-hidden="true" className="size-2 shrink-0 bg-attention" />;
}

export function AttentionRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <li className={ROW_CLASS}>
      <div className="pt-1.5 flex">
        <AttentionMark />
      </div>
      <div className="grid gap-1 wrap-anywhere">
        <p className="font-strong">{title}</p>
        <p className="text-pretty text-muted-foreground">{detail}</p>
      </div>
      <div className="flex flex-col items-end gap-1">{children}</div>
    </li>
  );
}

export function AttentionRowsSkeleton() {
  return (
    <ul aria-label="Loading attention" aria-busy="true">
      {["first", "second", "third"].map((row) => (
        <li key={row} aria-hidden="true" className={ROW_CLASS}>
          <Skeleton className="mt-1.5 size-2" />
          <div className="grid gap-1">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-full" />
          </div>
          <Skeleton className="h-5 w-24" />
        </li>
      ))}
    </ul>
  );
}
