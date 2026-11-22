const MAX_CONCURRENT_PROVIDER_READS = 4;

export type ProviderReadLimiter = <T>(signal: AbortSignal, read: () => Promise<T>) => Promise<T>;

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
        // An aborted request still occupies a slot until its transport settles.
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return read();
          })
          .then(resolve, reject)
          .finally(() => {
            running--;
            dispatch();
          });
      }

      queue.add(start);
      signal.addEventListener("abort", cancel, { once: true });
      dispatch();
    });
}
