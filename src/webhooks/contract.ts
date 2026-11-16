export function webhookUrl(baseUrl: string, trigger: string): string {
  return new URL(`/api/v1/hooks/${encodeURIComponent(trigger)}`, baseUrl).toString();
}

export function webhookCurl(
  baseUrl: string,
  trigger: string,
  data: Readonly<Record<string, unknown>> = { message: "Event received" },
): string {
  const body = JSON.stringify(data).replaceAll("'", "'\\''");
  return `curl -sS -X POST '${webhookUrl(baseUrl, trigger)}' \\\n  -H "Authorization: Bearer $HUB_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: example-delivery' \\\n  -d '${body}'`;
}
