// GitHub timestamps comments on a different clock; older comments fall outside this lookup.
const COMMENT_CLOCK_SKEW_MS = 10 * 60 * 1_000;

export function billingNoticeSince(receivedAt: string): string | undefined {
  const earliest = Date.parse(receivedAt) - COMMENT_CLOCK_SKEW_MS;
  const rounded = new Date(Math.floor(earliest / 1_000) * 1_000);
  if (Number.isNaN(rounded.getTime())) return undefined;
  return rounded.toISOString().replace(".000Z", "Z");
}

export function executionLimitNoticeMarker(deliveryId: string, issueNumber: number): string {
  const encoded = encodeURIComponent(deliveryId).replaceAll("-", "%2D");
  return `<!-- paseo-notice:execution-limit:${encoded}:${issueNumber} -->`;
}
