import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, vi } from "vitest";
import { RunEventSubscription } from "./run-event-subscription.js";
import { runReadClock } from "./run-read.js";
import type { RunEventPage } from "./run-events.js";
import { emptyTimeline, runEvent } from "./test-utils/run-detail.js";

const potential: RunEventPage = { ...emptyTimeline, streamEnabled: false, origin: null };
const absent: RunEventPage = {
  ...potential,
  status: "succeeded",
  timelineEnabled: false,
  timelineUnavailable: true,
};

function open(initial = potential, initialSequence = 0) {
  const seal = vi.fn();
  const subscription = new RunEventSubscription({
    initial,
    initialSequence,
    after: 0,
    url: "/events?organization=example",
    source: () => {
      throw new Error("Unexpected event source");
    },
    probe: async () => 200,
    onSeal: seal,
  });
  subscription.start();
  return { subscription, seal };
}

function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (values.length === 0) {
    yield [];
    return;
  }
  for (const [index, value] of values.entries()) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) yield [value, ...tail];
  }
}

const flags = [false, true];

interface AvailabilityCase {
  newestUnavailable: boolean;
  newestSnapshot: boolean;
  history: boolean;
}

const availabilityCases: AvailabilityCase[] = flags.flatMap((newestUnavailable) =>
  flags.flatMap((newestSnapshot) =>
    flags.map((history) => ({ newestUnavailable, newestSnapshot, history })),
  ),
);

interface TimelineRead {
  sequence: number;
  snapshot: boolean;
  page: RunEventPage;
}

function applyReads(subscription: RunEventSubscription, reads: readonly TimelineRead[]) {
  for (const { snapshot, page, sequence } of reads) {
    if (snapshot) subscription.acceptSnapshot(page, sequence);
    else subscription.acceptPage(page, sequence);
  }
}

function availabilityCaseName(
  { newestUnavailable, newestSnapshot, history }: AvailabilityCase,
  reverse: boolean,
) {
  return `applies ${newestUnavailable ? "unavailable" : "available"} ${newestSnapshot ? "snapshot" : "event"} with ${history ? "history" : "no history"} ${reverse ? "reversed" : "in issue order"}`;
}

function checkAvailability(
  { newestUnavailable, newestSnapshot, history }: AvailabilityCase,
  reverse: boolean,
) {
  const initial = history
    ? { ...potential, origin: "captured" as const, events: [runEvent(1, "run_started")] }
    : potential;
  const { subscription, seal } = open(initial);
  const older: RunEventPage = {
    ...potential,
    status: "succeeded",
    timelineEnabled: newestUnavailable,
    timelineUnavailable: !newestUnavailable,
    retentionDays: 7,
  };
  const newer: RunEventPage = {
    ...potential,
    status: "succeeded",
    timelineEnabled: !newestUnavailable,
    timelineUnavailable: newestUnavailable,
    retentionDays: 30,
  };
  const reads = [
    { sequence: 1, snapshot: !newestSnapshot, page: older },
    { sequence: 2, snapshot: newestSnapshot, page: newer },
  ] as const;
  try {
    applyReads(subscription, reverse ? [reads[1], reads[0]] : reads);
    assert.equal(subscription.snapshot().timelineEnabled, !newestUnavailable);
    assert.equal(subscription.snapshot().retentionDays, 30);
    assert.equal(subscription.snapshot().timelineUnavailable, !history && newestUnavailable);
    assert.equal(
      subscription.snapshot().connection,
      history || !newestUnavailable ? "Polling" : null,
    );
    if (history) {
      checkHistorySeal(subscription, newer, seal);
    } else {
      subscription.acceptSnapshot(absent, 3);
      assert.equal(subscription.snapshot().connection, null);
      assert.equal(seal.mock.calls.length, 0);
    }
  } finally {
    subscription.stop();
  }
}

function checkHistorySeal(
  subscription: RunEventSubscription,
  newer: RunEventPage,
  seal: ReturnType<typeof vi.fn>,
) {
  subscription.acceptPage(
    {
      ...newer,
      origin: "captured",
      sealedSeq: 2,
      events: [runEvent(2, "run_finished", { status: "succeeded" })],
    },
    3,
  );
  assert.equal(subscription.snapshot().connection, null);
  assert.deepEqual(
    subscription.snapshot().events.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(seal.mock.calls.length, 1);
}

function checkPermutation(
  initial: RunEventPage,
  metadata: RunEventPage,
  order: readonly TimelineRead[],
) {
  const { subscription, seal } = open(initial);
  try {
    applyReads(subscription, order);
    const state = subscription.snapshot();
    assert.deepEqual(
      state.events.map((event) => event.seq),
      [1, 2, 3],
    );
    assert.equal(state.lastSeq, 3);
    assert.equal(state.sealedSeq, 3);
    assert.equal(state.origin, metadata.origin);
    assert.equal(state.stepRowsOmitted, 7);
    assert.equal(state.droppedCount, 9);
    assert.equal(state.status, "succeeded");
    assert.equal(state.timelineUnavailable, false);
    assert.equal(state.connection, null);
    assert.equal(seal.mock.calls.length, 1);
    subscription.acceptPage({ ...metadata, expired: true, events: [] }, 6);
    subscription.acceptSnapshot(absent, 1);
    assert.equal(subscription.snapshot().expired, true);
    assert.deepEqual(subscription.snapshot().events, []);
    assert.equal(subscription.snapshot().lastSeq, 3);
    assert.equal(subscription.snapshot().sealedSeq, 3);
  } finally {
    subscription.stop();
  }
}

describe("issued run configuration evidence", () => {
  it("idles after capture is disabled before the first history row is stored", () => {
    const { subscription, seal } = open();
    try {
      subscription.acceptSnapshot(absent, 2);
      subscription.acceptPage(potential, 1);
      assert.equal(subscription.snapshot().timelineUnavailable, true);
      assert.equal(subscription.snapshot().connection, null);
      assert.equal(subscription.snapshot().origin, null);
      assert.deepEqual(subscription.snapshot().events, []);
      assert.equal(seal.mock.calls.length, 0);
    } finally {
      subscription.stop();
    }
  });

  it("accepts history from an older issued read after a newer final absence", () => {
    const { subscription, seal } = open();
    try {
      subscription.acceptSnapshot(absent, 2);
      subscription.acceptPage(
        { ...potential, origin: "captured", events: [runEvent(1, "run_started")] },
        1,
      );
      assert.equal(subscription.snapshot().timelineUnavailable, false);
      assert.equal(subscription.snapshot().connection, "Polling");
      assert.deepEqual(
        subscription.snapshot().events.map((event) => event.seq),
        [1],
      );
      subscription.acceptPage(
        {
          ...potential,
          origin: "captured",
          status: "succeeded",
          sealedSeq: 2,
          events: [runEvent(2, "run_finished", { status: "succeeded" })],
        },
        3,
      );
      assert.equal(subscription.snapshot().connection, null);
      assert.equal(seal.mock.calls.length, 1);
    } finally {
      subscription.stop();
    }
  });

  for (const scenario of availabilityCases) {
    for (const reverse of flags) {
      it(availabilityCaseName(scenario, reverse), () => {
        checkAvailability(scenario, reverse);
      });
    }
  }

  for (const origin of ["captured", "derived"] as const) {
    for (const capture of [false, true]) {
      it(`retains ${origin} history in all 120 arrival permutations with capture ${String(capture)}`, () => {
        let checked = 0;
        const initial = { ...potential, timelineEnabled: capture, timelineUnavailable: !capture };
        const metadata: RunEventPage = {
          ...potential,
          origin,
          status: "succeeded",
          sealedSeq: 3,
          stepRowsOmitted: 7,
          droppedCount: 9,
        };
        const reads = [
          { sequence: 1, snapshot: true, page: absent },
          { sequence: 4, snapshot: false, page: metadata },
          {
            sequence: 2,
            snapshot: false,
            page: {
              ...metadata,
              sealedSeq: null,
              events: [
                runEvent(1, "run_started"),
                runEvent(2, "step_finished", { status: "succeeded" }),
              ],
            },
          },
          {
            sequence: 5,
            snapshot: false,
            page: { ...metadata, events: [runEvent(3, "run_finished", { status: "succeeded" })] },
          },
          { sequence: 0, snapshot: false, page: { ...absent, status: "running" } },
        ];
        for (const order of permutations(reads)) {
          checkPermutation(initial, metadata, order);
          checked += 1;
        }
        assert.equal(checked, 120);
      });
    }
  }

  it("shares issuance order across detail and event reads after a cached snapshot", () => {
    const client = new QueryClient();
    client.setQueryData(["run-detail", "example", "run"], { sequence: 40, value: null });
    const detailRequests = runReadClock(client);
    const eventRequests = runReadClock(client);
    const detailSequence = detailRequests.issue();
    const eventSequence = eventRequests.issue();
    const { subscription } = open(potential, 40);
    try {
      subscription.acceptPage(absent, eventSequence);
      subscription.acceptSnapshot({ ...potential, status: "succeeded" }, detailSequence);
      assert.equal(subscription.snapshot().timelineUnavailable, true);
      assert.equal(subscription.snapshot().connection, null);
    } finally {
      subscription.stop();
      client.clear();
    }
  });
});
