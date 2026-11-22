import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { QueryHandle } from "../db/runtime/index.js";
import { recordLinearPilotAdmission } from "./admission-receipt.js";

const evidence = {
  organizationId: "hub-org",
  workspaceId: "linear-workspace",
  applicationId: "linear-app",
  appUserId: "app-user",
  humanId: "pilot-human",
  connectionId: "ac897cab-5d7f-4eb4-b10a-3998b9c437aa",
  ownerUserId: "hub-owner",
  profileId: "32624952-2c32-4b06-92a4-fc6e6c9f224d",
  profileVersion: 3,
  nativeSessionId: "native-session",
  receivedAt: new Date("2026-01-01T00:00:00Z"),
} as const;

describe("pilot admission receipt", () => {
  it("admits one semantic delivery even if the webhook was delivered again later", async () => {
    const written = new Set<unknown>();
    const db: QueryHandle = {
      query: async (sql, params) => {
        assert.match(sql, /on conflict do nothing/i);
        const receiptKey = params?.[0];
        assert.equal(typeof receiptKey, "string");
        const first = !written.has(receiptKey);
        written.add(receiptKey);
        return { rows: [], rowCount: first ? 1 : 0 };
      },
    };

    const created = { ...evidence, kind: "created" } as const;
    assert.equal(await recordLinearPilotAdmission(db, created), true);
    assert.equal(
      await recordLinearPilotAdmission(db, {
        ...created,
        receivedAt: new Date("2026-01-01T00:00:03Z"),
      }),
      false,
    );
    assert.equal(
      await recordLinearPilotAdmission(db, {
        ...evidence,
        kind: "prompted",
        activityId: "reply-1",
      }),
      true,
    );
    assert.equal(
      await recordLinearPilotAdmission(db, {
        ...evidence,
        kind: "stop",
        activityId: "reply-1",
      }),
      false,
    );
  });

  it("leaves stale authority ineligible and never includes prompt or token columns", async () => {
    const db: QueryHandle = {
      query: async (sql, params) => {
        assert.match(sql, /from linear_connections/i);
        assert.match(sql, /\bmember\b/i);
        assert.match(sql, /\binteractive_session_profiles\b/i);
        assert.doesNotMatch(sql, /(?:refresh|access)_token|prompt_context|linear_template/i);
        assert.doesNotMatch(JSON.stringify(params), /private provider text/);
        return { rows: [], rowCount: 0 };
      },
    };
    const input = { ...evidence, kind: "created", message: "private provider text" } as const;

    assert.equal(await recordLinearPilotAdmission(db, input), false);
  });
});
