const MAX_CONCURRENT_PROVIDER_READS = 4;
const PROVIDER_READ_DEADLINE_MS = 15_000;

interface QueuedRead {
  daemonId: string;
  start: () => void;
  drop: () => void;
}

export class ProviderReadTimeout extends Error {
  constructor() {
    super("This daemon did not answer.");
  }
}

export type ProviderReadLimiter = ReturnType<typeof createProviderReadLimiter>;

export function createProviderReadLimiter() {
  const queue = new Set<QueuedRead>();
  let order = new Map<string, number>();
  let running = 0;

  function dispatch() {
    if (running === MAX_CONCURRENT_PROVIDER_READS) return;
    let next: QueuedRead | undefined;
    let nextRank = Infinity;
    for (const read of queue) {
      const rank = order.get(read.daemonId);
      if (rank !== undefined && rank < nextRank) {
        next = read;
        nextRank = rank;
      }
    }
    if (next === undefined) return;
    queue.delete(next);
    running++;
    next.start();
  }

  function reconcile(daemonIds: readonly string[]) {
    order = new Map(daemonIds.map((id, index) => [id, index]));
    for (const read of queue) {
      if (!order.has(read.daemonId)) read.drop();
    }
  }

  const schedule = createSchedule({
    queue,
    isKnown: (daemonId) => order.has(daemonId),
    dispatch,
    release: () => {
      running--;
      dispatch();
    },
  });
  return { schedule, reconcile };
}

interface ScheduleQueue {
  queue: Set<QueuedRead>;
  isKnown: (daemonId: string) => boolean;
  dispatch: () => void;
  release: () => void;
}

function createSchedule({ queue, isKnown, dispatch, release }: ScheduleQueue) {
  return function schedule<T>(
    daemonId: string,
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<T>,
    cancelQuery?: () => void,
  ) {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const controller = new AbortController();
      const requestSignal = AbortSignal.any([signal, controller.signal]);
      const queued = { daemonId, start, drop };

      function cancel() {
        queue.delete(queued);
        reject(signal.reason);
      }

      function drop() {
        const error = new DOMException("Daemon left the provider read queue.", "AbortError");
        signal.removeEventListener("abort", cancel);
        queue.delete(queued);
        controller.abort(error);
        cancelQuery?.();
        reject(error);
      }

      function start() {
        signal.removeEventListener("abort", cancel);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(() => {
            const error = new ProviderReadTimeout();
            rejectTimeout(error);
            controller.abort(error);
          }, PROVIDER_READ_DEADLINE_MS);
        });
        const response = Promise.resolve().then(() => {
          requestSignal.throwIfAborted();
          return read(requestSignal);
        });
        // A transport that ignores abort cannot keep a slot beyond the deadline.
        void Promise.race([response, timeout])
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer);
            release();
          });
      }

      if (!isKnown(daemonId)) {
        drop();
        return;
      }
      queue.add(queued);
      signal.addEventListener("abort", cancel, { once: true });
      dispatch();
    });
  };
}
