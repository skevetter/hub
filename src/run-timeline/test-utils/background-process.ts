import { createMemoryDatabase } from "../../db/memory.js";
import { RunTimelineBus } from "../bus.js";
import { RunTimeline } from "../index.js";
import { RunTimelineReconciler } from "../reconcile.js";
import { TimelineRetention } from "../retention.js";
import { createTimelineScrubber } from "../scrub.js";
import { RunTimelineQueue } from "../queue.js";

const mode = process.argv[2];
if (mode === "reconciliation") {
  const database = createMemoryDatabase();
  const options = {
    bus: new RunTimelineBus(),
    scrub: createTimelineScrubber(),
    maxEvents: 500,
    retentionDays: 30,
  };
  const timeline = new RunTimeline(database, options);
  new RunTimelineReconciler(database, { ...options, queue: timeline }).start();
} else if (mode === "retention") {
  new TimelineRetention({ expireRunTimelines: async () => 0 }, { retentionDays: 30 }).start();
} else if (mode === "retention_pause") {
  const keepAlive = setTimeout(() => undefined, 60_000);
  new TimelineRetention(
    {
      expireRunTimelines: async () => {
        setImmediate(() => clearTimeout(keepAlive));
        return 500;
      },
    },
    { retentionDays: 30 },
  ).start();
} else if (mode === "accounting") {
  const queue = new RunTimelineQueue(
    {
      recordRunTimelineDrops: async () => {
        throw new Error("Fixture accounting unavailable");
      },
    },
    { bus: new RunTimelineBus() },
  );
  queue.recordDrops({ organizationId: "fixture", triggerRunId: "fixture" }, 1);
} else {
  throw new Error("Unknown background sweeper mode");
}
process.stdout.write("ready\n");
