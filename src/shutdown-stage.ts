import { logger } from "./logger.js";

export async function runShutdownStage<T>(stage: string, stop: () => Promise<T>): Promise<T> {
  const started = performance.now();
  logger.info({ stage, phase: "start", elapsedMs: 0 }, "shutdown stage started");
  let failed = true;
  try {
    const result = await stop();
    failed = false;
    return result;
  } finally {
    logger.info(
      { stage, phase: "end", elapsedMs: Math.round(performance.now() - started), failed },
      "shutdown stage ended",
    );
  }
}
