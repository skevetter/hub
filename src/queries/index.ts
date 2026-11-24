import { useQuery, type QueryFunctionContext, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Result } from "../contract/respond.js";

/** A read has content, is awaiting its first answer, or could not obtain an answer. */
export type Snapshot<T> =
  | { status: "pending"; data: undefined; error: null }
  | { status: "error"; data: undefined; error: string | null }
  | { status: "success"; data: T; error: null };

class SnapshotFailure extends Error {}

const defaultRetry = (failureCount: number): boolean => failureCount < 2;

/**
 * Server Result failures belong to the query's error channel, never its data cache. React Query
 * retains the last successful value and retries a failed read twice. A background failure does
 * not take existing content away; an initial failure keeps the server's message and reference.
 * Query keys still own identity: another organization or resource starts with its own snapshot.
 */
export function useSnapshotQuery<T>(options: {
  queryKey: QueryKey;
  queryFn: (context: QueryFunctionContext) => Promise<Result<T>>;
  enabled?: boolean;
  refetchInterval?: number;
  /** Whether to ask again after a failure. `message` is the server's, null when none arrived. */
  retry?: (failureCount: number, message: string | null) => boolean;
}): Snapshot<T> & {
  refetch: (options?: { cancelRefetch?: boolean }) => void;
  isFetching: boolean;
  /** Set when a background refresh failed and the data shown is the last good answer. */
  refreshFailure: { message: string | null } | null;
} {
  const { retry = defaultRetry, ...queryOptions } = options;
  const query = useQuery({
    ...queryOptions,
    queryFn: async (context) => {
      const result = await options.queryFn(context);
      if (result.status === "error") throw new SnapshotFailure(result.error.message);
      return result.data;
    },
    retry: (failureCount, error) =>
      retry(failureCount, error instanceof SnapshotFailure ? error.message : null),
  });
  const reload = query.refetch;
  const refetch = useCallback(
    (refetchOptions?: { cancelRefetch?: boolean }) => {
      void reload(refetchOptions);
    },
    [reload],
  );
  if (query.data !== undefined)
    return {
      status: "success",
      data: query.data,
      error: null,
      refetch,
      isFetching: query.isFetching,
      refreshFailure: query.isRefetchError
        ? { message: query.error instanceof SnapshotFailure ? query.error.message : null }
        : null,
    };
  if (query.isPending)
    return {
      status: "pending",
      data: undefined,
      error: null,
      refetch,
      isFetching: query.isFetching,
      refreshFailure: null,
    };
  return {
    status: "error",
    data: undefined,
    error: query.error instanceof SnapshotFailure ? query.error.message : null,
    refetch,
    isFetching: query.isFetching,
    refreshFailure: null,
  };
}
