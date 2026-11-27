const NON_SECRET_ENVIRONMENT_NAMES: Readonly<Record<string, true | undefined>> = {
  GITHUB_APP_PRIVATE_KEY_PATH: true,
  PASEO_HUB_STREAM_MAX_PER_KEY: true,
  PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID: true,
  PASEO_E2E_TLS_KEY: true,
  PASEO_E2E_MACHINE_KEY_FILE: true,
  HUB_E2E_MACHINE_KEY_FILE: true,
};

export function readTimelineScrubValues(
  environment: Readonly<Record<string, string | undefined>>,
  providerConfigurations: readonly object[] = [],
): readonly string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(environment)) addEnvironmentValue(name, value, values);
  for (const configuration of providerConfigurations) addProviderValues(configuration, values);
  return [...values];
}

function addEnvironmentValue(name: string, value: string | undefined, values: Set<string>): void {
  if (value === undefined || value.length === 0 || NON_SECRET_ENVIRONMENT_NAMES[name] === true)
    return;
  if (name !== "DATABASE_URL" && !/KEY|SECRET|TOKEN|PASSWORD/u.test(name)) return;
  values.add(value);
  const effective = value.trim();
  if (effective.length !== 0) values.add(effective);
  if (name === "PASEO_HUB_WEBHOOK_HMAC_KEYRING") addKeyringEntries(value, values);
}

function addProviderValues(configuration: object, values: Set<string>): void {
  for (const [name, value] of Object.entries(configuration)) {
    if (typeof value === "string" && value.length !== 0 && /secret|token|privatekey/iu.test(name))
      values.add(value);
  }
}

// The keyring is a JSON object, so each key must be scrubbed on its own when it appears outside the JSON.
function addKeyringEntries(keyring: string, values: Set<string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keyring);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  for (const entry of Object.values(parsed)) {
    if (typeof entry === "string" && entry.length !== 0) values.add(entry);
  }
}
