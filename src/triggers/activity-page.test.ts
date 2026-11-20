import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dashboardWithRuns } from "../test-utils/activity-dashboard.js";
import { decodeActivityCursor, encodeActivityCursor } from "./activity-cursor.js";

const TOTAL = 7;

describe("trigger activity pages", () => {
  it("walks every run once, newest first, and back again", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const walked: string[][] = [];
    let cursor: string | undefined;
    let previous: string[] = [];
    for (;;) {
      const page = await dashboard.activityPage(request, "acme", {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      walked.push(page.activity.map(({ id }) => id));
      previous.push(page.previousCursor ?? "none");
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(
      walked.map((ids) => ids.length),
      [3, 3, 1],
    );
    const ids = walked.flat();
    assert.equal(new Set(ids).size, TOTAL);
    const first = await dashboard.activityPage(request, "acme", { limit: TOTAL });
    assert.deepEqual(
      ids,
      first.activity.map(({ id }) => id),
    );
    assert.equal(first.nextCursor, null);
    assert.equal(first.previousCursor, null);
    assert.equal(previous[0], "none");

    const back: string[][] = [];
    cursor = previous.at(-1);
    while (cursor !== undefined && cursor !== "none") {
      const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
      back.unshift(page.activity.map(({ id }) => id));
      cursor = page.previousCursor ?? undefined;
    }
    assert.deepEqual(back, walked.slice(0, 2));
  });

  it("defaults to 25 rows and caps the page at 100", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    assert.equal((await dashboard.activityPage(request, "acme", {})).limit, 25);
    assert.equal((await dashboard.activityPage(request, "acme", { limit: 500 })).limit, 100);
  });

  it("serves the newest page for a cursor it cannot read", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const newest = await dashboard.activityPage(request, "acme", { limit: 3 });
    const bad = [
      "not-a-cursor",
      Buffer.from('["before","2026-01-01T00:00:00Z","not-a-uuid"]').toString("base64url"),
      Buffer.from(
        '["sideways","2026-01-01T00:00:00Z","00000000-0000-4000-8000-000000000000"]',
      ).toString("base64url"),
      Buffer.from("[]").toString("base64url"),
    ];
    for (const cursor of bad) {
      const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
      assert.deepEqual(
        page.activity.map(({ id }) => id),
        newest.activity.map(({ id }) => id),
      );
      assert.equal(page.previousCursor, null);
    }
  });

  it("falls back to the newest page when the cursor's side is empty", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const cursor = encodeActivityCursor("before", {
      createdAt: "2000-01-01T00:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000000",
    });
    const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
    assert.equal(page.activity.length, 3);
    assert.equal(page.previousCursor, null);
  });

  it("refuses timestamps that are not real calendar times or offsets", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const createdAt of [
      "2026-13-40T25:61:61Z",
      "2026-02-30T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+25:00",
      "2026-01-01T00:00:00+05:75",
      "2026-01-01 00:00:00.1234567+00",
    ]) {
      assert.equal(
        decodeActivityCursor(encodeActivityCursor("before", { createdAt, id })),
        undefined,
        createdAt,
      );
    }
    assert.ok(
      decodeActivityCursor(
        encodeActivityCursor("before", { createdAt: "2024-02-29 23:59:59.999999-05:30", id }),
      ),
    );
    assert.equal(decodeActivityCursor("a".repeat(513)), undefined);
  });

  it("serves the newest page for a cursor that is too long or has an impossible timestamp", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const newest = await dashboard.activityPage(request, "acme", { limit: 3 });
    const cursors = [
      "a".repeat(513),
      encodeActivityCursor("before", {
        createdAt: "2026-13-40T25:61:61Z",
        id: newest.activity[0]!.id,
      }),
    ];
    for (const cursor of cursors) {
      const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
      assert.deepEqual(
        page.activity.map(({ id }) => id),
        newest.activity.map(({ id }) => id),
      );
    }
  });

  it("compares cursor ids without regard to case, as PostgreSQL does for uuid", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const first = await dashboard.activityPage(request, "acme", { limit: 3 });
    const raw = decodeActivityCursor(first.nextCursor!)!;
    const upper = encodeActivityCursor("before", { ...raw.key, id: raw.key.id.toUpperCase() });
    const exact = await dashboard.activityPage(request, "acme", {
      limit: 3,
      cursor: first.nextCursor!,
    });
    const shouted = await dashboard.activityPage(request, "acme", { limit: 3, cursor: upper });
    assert.deepEqual(
      shouted.activity.map(({ id }) => id),
      exact.activity.map(({ id }) => id),
    );
  });

  it("orders a cursor against runs by microseconds, not milliseconds", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const first = await dashboard.activityPage(request, "acme", { limit: 1 });
    const ms = decodeActivityCursor(first.nextCursor!)!.key;
    const justAfter = { createdAt: ms.createdAt.replace("Z", "500Z"), id: ms.id };
    // A key 500 microseconds after the run's millisecond is newer than that run.
    const older = await dashboard.activityPage(request, "acme", {
      limit: TOTAL,
      cursor: encodeActivityCursor("before", justAfter),
    });
    assert.ok(older.activity.some(({ id }) => id === ms.id));
    const exact = await dashboard.activityPage(request, "acme", {
      limit: TOTAL,
      cursor: encodeActivityCursor("before", ms),
    });
    assert.ok(exact.activity.every(({ id }) => id !== ms.id));
  });

  it("accepts only the exact text the encoder writes", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const first = await dashboard.activityPage(request, "acme", { limit: 3 });
    const good = first.nextCursor!;
    assert.ok(decodeActivityCursor(good));
    for (const cursor of [`${good}!!`, `${good}=`, `${good}\n`, ` ${good}`, `${good}AA`, "123"]) {
      assert.equal(decodeActivityCursor(cursor), undefined, JSON.stringify(cursor));
    }
    const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor: `${good}!!` });
    assert.equal(page.previousCursor, null);
  });

  it("reads back the cursors it writes", () => {
    const key = { createdAt: "2026-01-01 00:00:00.123456+00", id: crypto.randomUUID() };
    assert.deepEqual(decodeActivityCursor(encodeActivityCursor("after", key)), {
      direction: "after",
      key,
    });
    assert.equal(decodeActivityCursor(undefined), undefined);
  });
});
