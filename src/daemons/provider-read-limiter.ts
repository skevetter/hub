const MAX_CONCURRENT_PROVIDER_READS = 4;
const PROVIDER_READ_DEADLINE_MS = 15_000;

export class ProviderReadTimeout extends Error {
  constructor() {
    super("This daemon did not answer.");
  }
}

export type ProviderReadLimiter = <T>(
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export function createProviderReadLimiter(): ProviderReadLimiter {
  const queue = new Set<() => void>();
  let running = 0;

  function dispatch() {
    if (running === MAX_CONCURRENT_PROVIDER_READS) return;
    const start = queue.values().next().value;
    if (start === undefined) return;
    queue.delete(start);
    running++;
    start();
  }

  return (signal, read) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      function cancel() {
        queue.delete(start);
        reject(signal.reason);
      }

      function start() {
        signal.removeEventListener("abort", cancel);
        const deadline = new AbortController();
        const requestSignal = AbortSignal.any([signal, deadline.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(() => {
            const error = new ProviderReadTimeout();
            rejectTimeout(error);
            deadline.abort(error);
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
            running--;
            dispatch();
          });
      }

      queue.add(start);
      signal.addEventListener("abort", cancel, { once: true });
      dispatch();
    });
}
