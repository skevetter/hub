import type { QueryClient } from "@tanstack/react-query";
import { respondOk, type Result } from "../contract/respond.js";

export interface RunRead<T> {
  sequence: number;
  value: T;
}

export class RunRequestClock {
  constructor(private sequence = 0) {}

  issue() {
    this.sequence += 1;
    return this.sequence;
  }
}

const clocks = new WeakMap<QueryClient, RunRequestClock>();

export function runReadClock(client: QueryClient) {
  let clock = clocks.get(client);
  if (clock !== undefined) return clock;
  let sequence = 0;
  for (const query of client.getQueryCache().getAll()) {
    const kind = query.queryKey[0];
    if (kind !== "run-detail" && kind !== "run-events") continue;
    const data: unknown = query.state.data;
    if (hasReadSequence(data)) sequence = Math.max(sequence, data.sequence);
  }
  clock = new RunRequestClock(sequence);
  clocks.set(client, clock);
  return clock;
}

function hasReadSequence(data: unknown): data is { sequence: number } {
  return (
    typeof data === "object" &&
    data !== null &&
    "sequence" in data &&
    typeof data.sequence === "number" &&
    Number.isSafeInteger(data.sequence) &&
    data.sequence >= 0
  );
}

export function runReadResult<T>(sequence: number, result: Result<T>): Result<RunRead<T>> {
  return result.status === "error" ? result : respondOk({ sequence, value: result.data });
}
