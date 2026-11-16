const SECRET_ENVIRONMENT_NAMES = [
  "GITHUB_NOTIFICATIONS_TOKEN",
  "PASEO_HUB_PROGRESS_GITHUB_TOKEN",
  "PASEO_HUB_AUTH_SECRET",
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
] as const;

export function readTimelineScrubValues(
  environment: Readonly<Record<string, string | undefined>>,
  providerConfigurations: readonly object[] = [],
): readonly string[] {
  const values = new Set<string>();
  for (const name of SECRET_ENVIRONMENT_NAMES) {
    const value = environment[name];
    if (value !== undefined && value.length !== 0) values.add(value);
  }
  for (const configuration of providerConfigurations) {
    for (const [name, value] of Object.entries(configuration)) {
      if (typeof value === "string" && value.length !== 0 && /secret|token|privatekey/iu.test(name))
        values.add(value);
    }
  }
  return [...values];
}
