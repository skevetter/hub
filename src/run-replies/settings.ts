export function readRunReplyLimit(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const key = "PASEO_HUB_LINEAR_REPLIES_PER_HOUR";
  const raw = environment[key]?.trim();
  if (raw === undefined || raw === "") return 60;
  const limit = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(`${key} must be a positive whole number.`);
  return limit;
}
