import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PAGE_SIZES } from "../components/app/page-size.js";
import { dashboardWithRuns } from "../test-utils/activity-dashboard.js";
import {
  activityCursorScope,
  decodeActivityCursor,
  encodeActivityCursor,
} from "./activity-cursor.js";
import { activitySearchSchema } from "./activity-query.js";

const TOTAL = 7;
const scope = (limit: number) => activityCursorScope("org-1", limit, {});

describe("activity search", () => {
  it("normalizes supported filters, size and trigger ids", () => {
    const trigger = crypto.randomUUID();
    assert.deepEqual(
      activitySearchSchema.parse({
        status: "timed_out",
        provider: "webhook",
        trigger: trigger.toUpperCase(),
        range: "30d",
        size: "50",
      }),
      { status: "timed_out", provider: "webhook", trigger, range: "30d", size: 50 },
    );
  });

  it("drops invalid filters and sends an invalid size to the default", () => {
    assert.deepEqual(
      activitySearchSchema.parse({
        status: "dropped",
        provider: "other",
        trigger: "wrong",
        range: "all",
        cursor: 123,
        size: 20,
      }),
      {
        status: undefined,
        provider: undefined,
        trigger: undefined,
        range: undefined,
        cursor: undefined,
        size: 15,
      },
    );
  });
});

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

  it("defaults to 15 rows and caps the page at 100", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    assert.equal((await dashboard.activityPage(request, "acme", {})).limit, 15);
    assert.equal((await dashboard.activityPage(request, "acme", { limit: 500 })).limit, 100);
  });

  it.each(PAGE_SIZES)("walks tied memory rows both ways at size %i", async (limit) => {
    const { dashboard, request } = await dashboardWithRuns(128);
    const read = (cursor?: string) => dashboard.activityPage(request, "acme", { limit, cursor });
    const pages: string[][] = [];
    const ids = (page: Awaited<ReturnType<typeof read>>) => page.activity.map(({ id }) => id);
    let page = await read();
    for (;;) {
      assert.equal(page.startOffset, pages.length * limit);
      pages.push(ids(page));
      if (page.nextCursor === null) break;
      page = await read(page.nextCursor);
    }
    assert.equal(new Set(pages.flat()).size, 128);
    assert.equal(pages.flat().length, 128);
    assert.deepEqual(pages.flat(), pages.flat().toSorted().toReversed());
    for (const expected of pages.slice(0, -1).toReversed()) {
      assert.ok(page.previousCursor);
      page = await read(page.previousCursor);
      assert.deepEqual(ids(page), expected);
    }
  });

  it("filters by status, provider, trigger and time before taking a page", async () => {
    const { dashboard, request } = await dashboardWithRuns(20);
    const first = await dashboard.activityPage(request, "acme", {});
    const trigger = first.activity[0]!.triggerId;
    const matched = await dashboard.activityPage(request, "acme", {
      status: "running",
      provider: "manual",
      trigger,
      range: "24h",
    });
    assert.deepEqual(matched.activity, first.activity);
    for (const filters of [
      { status: "failed" },
      { provider: "webhook" },
      { trigger: crypto.randomUUID() },
    ] as const) {
      const page = await dashboard.activityPage(request, "acme", filters);
      assert.deepEqual(page.activity, []);
      assert.equal(page.nextCursor, null);
    }
  });

  it("falls back to page one when a cursor comes from a different filter or size", async () => {
    const { dashboard, request } = await dashboardWithRuns(45);
    const first = await dashboard.activityPage(request, "acme", {});
    assert.ok(first.nextCursor);
    for (const search of [{ status: "running" }, { provider: "manual" }, { limit: 25 }] as const) {
      const filtered = await dashboard.activityPage(request, "acme", search);
      const stale = await dashboard.activityPage(request, "acme", {
        ...search,
        cursor: first.nextCursor,
      });
      assert.deepEqual(stale.activity, filtered.activity);
      assert.equal(stale.previousCursor, null);
    }
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
    const cursor = encodeActivityCursor(
      "before",
      {
        createdAt: "2000-01-01T00:00:00.000Z",
        id: "00000000-0000-4000-8000-000000000000",
      },
      scope(3),
    );
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
        decodeActivityCursor(encodeActivityCursor("before", { createdAt, id }, scope(3)), scope(3)),
        undefined,
        createdAt,
      );
    }
    assert.ok(
      decodeActivityCursor(
        encodeActivityCursor(
          "before",
          { createdAt: "2024-02-29 23:59:59.999999-05:30", id },
          scope(3),
        ),
        scope(3),
      ),
    );
    assert.equal(decodeActivityCursor("a".repeat(513), scope(3)), undefined);
  });

  it("serves the newest page for a cursor that is too long or has an impossible timestamp", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const newest = await dashboard.activityPage(request, "acme", { limit: 3 });
    const cursors = [
      "a".repeat(513),
      encodeActivityCursor(
        "before",
        {
          createdAt: "2026-13-40T25:61:61Z",
          id: newest.activity[0]!.id,
        },
        scope(3),
      ),
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
    const raw = decodeActivityCursor(first.nextCursor!, scope(3))!;
    const upper = encodeActivityCursor(
      "before",
      { ...raw.key, id: raw.key.id.toUpperCase() },
      scope(3),
    );
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
    const ms = decodeActivityCursor(first.nextCursor!, scope(1))!.key;
    const justAfter = { createdAt: ms.createdAt.replace("Z", "500Z"), id: ms.id };
    // A key 500 microseconds after the run's millisecond is newer than that run.
    const older = await dashboard.activityPage(request, "acme", {
      limit: TOTAL,
      cursor: encodeActivityCursor("before", justAfter, scope(TOTAL)),
    });
    assert.ok(older.activity.some(({ id }) => id === ms.id));
    const exact = await dashboard.activityPage(request, "acme", {
      limit: TOTAL,
      cursor: encodeActivityCursor("before", ms, scope(TOTAL)),
    });
    assert.ok(exact.activity.every(({ id }) => id !== ms.id));
  });

  it("accepts only the exact text the encoder writes", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const first = await dashboard.activityPage(request, "acme", { limit: 3 });
    const good = first.nextCursor!;
    assert.ok(decodeActivityCursor(good, scope(3)));
    for (const cursor of [`${good}!!`, `${good}=`, `${good}\n`, ` ${good}`, `${good}AA`, "123"]) {
      assert.equal(decodeActivityCursor(cursor, scope(3)), undefined, JSON.stringify(cursor));
    }
    const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor: `${good}!!` });
    assert.equal(page.previousCursor, null);
  });

  it("reads back the cursors it writes", () => {
    const key = { createdAt: "2026-01-01 00:00:00.123456+00", id: crypto.randomUUID() };
    assert.deepEqual(decodeActivityCursor(encodeActivityCursor("after", key, scope(3)), scope(3)), {
      direction: "after",
      key,
    });
    assert.equal(decodeActivityCursor(undefined, scope(3)), undefined);
  });

  it("uses cursor offsets for display only and tolerates older or malformed offsets", async () => {
    const { dashboard, request } = await dashboardWithRuns(40);
    const first = await dashboard.activityPage(request, "acme", { limit: 15 });
    const firstKey = decodeActivityCursor(first.nextCursor!, scope(15))!.key;
    const prefix = ["before", firstKey.createdAt, firstKey.id, scope(15)];
    const list = async (offset?: unknown) => {
      const value = offset === undefined ? prefix : [...prefix, offset];
      const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
      return dashboard.activityPage(request, "acme", { limit: 15, cursor });
    };
    const second = await list(15);
    assert.equal(second.startOffset, 15);
    assert.notEqual(second.activity[0]?.id, first.activity[0]?.id);
    const forged = await list(26000);
    assert.equal(forged.startOffset, 26000);
    assert.deepEqual(forged.activity, second.activity);
    for (const offset of [undefined, -1, 0, 1.5, "15", Number.MAX_SAFE_INTEGER, {}]) {
      const page = await list(offset);
      assert.equal(page.startOffset, null);
      assert.deepEqual(page.activity, second.activity);
      assert.ok(page.previousCursor);
      const back = await dashboard.activityPage(request, "acme", {
        limit: 15,
        cursor: page.previousCursor,
      });
      assert.equal(back.startOffset, 0);
      assert.deepEqual(back.activity, first.activity);
    }
  });
});
