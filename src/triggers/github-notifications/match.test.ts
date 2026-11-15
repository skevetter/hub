import { describe, expect, it } from "vitest";
import { matchesNotification } from "./match.js";
import { toNotificationPayload, notificationDeliveryId } from "./notification.js";
import { thread } from "./test-fixture.js";

const payload = toNotificationPayload(thread());

describe("matchesNotification", () => {
  it("matches everything when no filter is set", () => {
    expect(matchesNotification(payload, undefined)).toBe(true);
    expect(matchesNotification(payload, {})).toBe(true);
  });

  it("matches the repository without regard to case", () => {
    expect(matchesNotification(payload, { repo: "thermai-group/FlightDeck" })).toBe(true);
    expect(matchesNotification(payload, { repo: "ThermAI-Group/terraform" })).toBe(false);
  });

  it("matches the reason exactly", () => {
    expect(matchesNotification(payload, { reason: "mention" })).toBe(true);
    expect(matchesNotification(payload, { reason: "review_requested" })).toBe(false);
  });

  it("applies contains and pattern to the subject title", () => {
    expect(matchesNotification(payload, { contains: "flaky" })).toBe(true);
    expect(matchesNotification(payload, { contains: "Flaky" })).toBe(false);
    expect(matchesNotification(payload, { pattern: "Fix the" })).toBe(true);
    expect(matchesNotification(payload, { pattern: "flaky" })).toBe(false);
  });

  it("requires every filter that is set", () => {
    const filters = { repo: "ThermAI-Group/flightdeck", reason: "mention", contains: "deploy" };
    expect(matchesNotification(payload, filters)).toBe(true);
    expect(matchesNotification(payload, { ...filters, reason: "author" })).toBe(false);
  });
});

describe("toNotificationPayload", () => {
  it("builds the pull request URL from the API URL", () => {
    expect(payload).toEqual({
      repo: "ThermAI-Group/flightdeck",
      thread_id: "1001",
      subject_type: "PullRequest",
      title: "Fix the flaky deploy check",
      number: 42,
      html_url: "https://github.com/ThermAI-Group/flightdeck/pull/42",
      reason: "mention",
      updated_at: "2026-11-14T10:00:00Z",
    });
  });

  it("builds issue URLs and leaves other subjects without one", () => {
    const issue = toNotificationPayload(
      thread({ type: "Issue", url: "https://api.github.com/repos/o/r/issues/7", repo: "o/r" }),
    );
    expect(issue).toMatchObject({ number: 7, html_url: "https://github.com/o/r/issues/7" });
    const commit = toNotificationPayload(
      thread({ type: "Commit", url: "https://api.github.com/repos/o/r/commits/abc123" }),
    );
    expect(commit).toMatchObject({ number: null, html_url: null });
    expect(toNotificationPayload(thread({ url: null }))).toMatchObject({ number: null });
  });

  it("keeps only the documented fields", () => {
    const withExtras = {
      ...thread(),
      subject: { ...thread().subject, latest_comment_url: "https://api.github.com/c/1" },
    };
    expect(Object.keys(toNotificationPayload(withExtras)).sort()).toEqual(
      [
        "html_url",
        "number",
        "reason",
        "repo",
        "subject_type",
        "thread_id",
        "title",
        "updated_at",
      ].sort(),
    );
  });

  it("derives the delivery id from the thread and its update time", () => {
    expect(notificationDeliveryId(payload)).toBe("1001:2026-11-14T10:00:00Z");
  });
});
