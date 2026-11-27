import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readDiscordOperatorAuth } from "../auth/discord.js";
import { readInstanceAuthPolicy } from "../auth/instance-policy.js";
import { readResendConfig } from "../email/internal/resend.js";
import { readProviderApplicationEnvironment } from "../provider-applications/internal/environment.js";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { readGitHubNotificationsOptions } from "../triggers/github-notifications/index.js";
import { projectTimelineEvent } from "./project.js";
import { createTimelineScrubber } from "./scrub.js";
import { readTimelineScrubValues } from "./secrets.js";

const SECRET_NAMES = [
  "DATABASE_URL",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_SECRET",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_NOTIFICATIONS_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "PASEO_BOOTSTRAP_OWNER_PASSWORD",
  "PASEO_E2E_SLACK_SIGNING_SECRET",
  "PASEO_HUB_AUTH_SECRET",
  "PASEO_HUB_EXECUTION_DONE_TOKEN",
  "PASEO_HUB_PROGRESS_GITHUB_TOKEN",
  "RESEND_API_KEY",
  "SLACK_APP_TOKEN",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

const NON_SECRET_NAMES: Readonly<Record<string, string>> = {
  GITHUB_APP_PRIVATE_KEY_PATH: "filesystem path; loaded private-key bytes are collected separately",
  PASEO_HUB_STREAM_MAX_PER_KEY: "numeric stream admission limit, not an API key",
  PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID: "signing key identifier, not key material",
  PASEO_E2E_TLS_KEY: "fixture TLS key filesystem path, not private-key bytes",
  PASEO_E2E_MACHINE_KEY_FILE: "fixture output filesystem path, not the generated credential",
  HUB_E2E_MACHINE_KEY_FILE: "fixture output filesystem path, not the generated credential",
};

function isEnvironment(node: ts.Node): boolean {
  return (
    (ts.isIdentifier(node) && /^(?:environment|env)$/u.test(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env")
  );
}

function readsEnvironment(node: ts.Node): boolean {
  return (
    ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) &&
      isEnvironment(node.expression)) ||
    ts.forEachChild(node, readsEnvironment) === true
  );
}

function visitCredentialCall(
  node: ts.CallExpression,
  add: (node: ts.Node | undefined) => void,
): void {
  if (
    node.arguments.some(isEnvironment) ||
    (ts.isIdentifier(node.expression) && /environment/iu.test(node.expression.text))
  ) {
    for (const argument of node.arguments) add(argument);
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isArrayLiteralExpression(node.expression.expression) &&
    node.arguments.some(readsEnvironment)
  ) {
    for (const element of node.expression.expression.elements) add(element);
  }
}

function credentialNames(source: string, fileName = "reader.ts"): string[] {
  const names = new Set<string>();
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const add = (node: ts.Node | undefined): void => {
    if (
      node &&
      (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) &&
      (node.text === "DATABASE_URL" ||
        /^[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*$/u.test(node.text))
    ) {
      names.add(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && isEnvironment(node.expression)) {
      add(node.argumentExpression);
    } else if (ts.isPropertyAccessExpression(node) && isEnvironment(node.expression)) {
      add(node.name);
    } else if (ts.isCallExpression(node)) {
      visitCredentialCall(node, add);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...names];
}

async function sourceCredentialNames(directory: URL): Promise<string[]> {
  const names = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "test-utils" || /\.test\./u.test(entry.name)) continue;
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      for (const name of await sourceCredentialNames(path)) names.add(name);
    } else if (/\.(?:ts|tsx|mjs)$/u.test(entry.name) && entry.name !== "secrets.ts") {
      for (const name of credentialNames(await readFile(path, "utf8"), path.pathname))
        names.add(name);
    }
  }
  return [...names].sort();
}

function projectedError(value: string, scrubValues: readonly string[]): string {
  const event = projectTimelineEvent(
    {
      kind: "agent_event",
      event: { type: "turn_failed", provider: "claude", error: `rejected <${value}> retry` },
    },
    createTimelineScrubber({ scrubValues }),
  );
  expect(event?.kind).toBe("turn_failed");
  const message = event?.data["error"];
  if (typeof message !== "string") throw new Error("Missing projected error");
  return message;
}

function expectProtected(
  environment: Record<string, string | undefined>,
  values: readonly string[],
): void {
  const collected = readTimelineScrubValues(environment);
  for (const value of values) {
    expect(collected).toContain(value);
    expect(projectedError(value, collected)).not.toContain(value.trim());
  }
}

function effectiveProviderCredentials(configurations: readonly object[]): string[] {
  const effective: string[] = [];
  for (const configuration of configurations) {
    for (const [name, value] of Object.entries(configuration)) {
      if (typeof value === "string" && /secret|token|privatekey/iu.test(name))
        effective.push(value);
    }
  }
  return effective;
}

describe("startup credential reader coverage", () => {
  it("inventories credential accesses and reader calls across all source, including fixture readers", async () => {
    expect(await sourceCredentialNames(new URL("../", import.meta.url))).toEqual(
      [...SECRET_NAMES, ...Object.keys(NON_SECRET_NAMES)].sort(),
    );
    for (const [index, name] of SECRET_NAMES.entries()) {
      const raw = `  fixture-${index}-mmmmmmmmmmmm  `;
      expectProtected({ [name]: raw }, [raw, raw.trim()]);
    }
  });

  it("detects an actual additional secret reader missing its coverage fixture", () => {
    const names = credentialNames(
      'export function readNewCredential(environment: Record<string, string | undefined>) { return environment["NEW_SERVICE_PASSWORD"]; }',
    );
    const covered = new Set<string>([...SECRET_NAMES, ...Object.keys(NON_SECRET_NAMES)]);
    expect(names.filter((name) => !covered.has(name))).toEqual(["NEW_SERVICE_PASSWORD"]);
    expectProtected({ NEW_SERVICE_PASSWORD: "  nnnnnnnnnnnn  " }, [
      "  nnnnnnnnnnnn  ",
      "nnnnnnnnnnnn",
    ]);
  });

  it("scrubs each signing key inside the webhook keyring", () => {
    const keyring = JSON.stringify({
      "key-1": "A".repeat(43) + "=",
      "key-2": "B".repeat(43) + "=",
    });
    const collected = readTimelineScrubValues({ PASEO_HUB_WEBHOOK_HMAC_KEYRING: keyring });
    expect(collected).toEqual(
      expect.arrayContaining([keyring, "A".repeat(43) + "=", "B".repeat(43) + "="]),
    );
    expect(readTimelineScrubValues({ PASEO_HUB_WEBHOOK_HMAC_KEYRING: "not json" })).toEqual([
      "not json",
    ]);
  });

  it.each(Object.entries(NON_SECRET_NAMES))("excludes non-secret %s: %s", (name) => {
    expect(readTimelineScrubValues({ [name]: "non-secret-fixture" })).toEqual([]);
  });

  it.each(["re_mmmmmmmmmmmm", "  re_mmmmmmmmmmmm  ", "\t re_mmmmmmmmmmmm \n"])(
    "protects raw and effective Resend API keys accepted by the real reader: %j",
    (raw) => {
      const environment = { RESEND_API_KEY: raw, RESEND_FROM: "Hub <hub@example.test>" };
      const config = readResendConfig(environment);
      expect(config?.apiKey).toBe("re_mmmmmmmmmmmm");
      expect(projectedError(config!.apiKey, [])).toContain(config!.apiKey);
      expectProtected(environment, [raw, config!.apiKey]);
    },
  );

  it.each(["pppppppppppp", "  pppppppppppp  ", "\u00a0pppppppppppp\u00a0"])(
    "protects raw and effective bootstrap passwords accepted unchanged by the real reader: %j",
    (raw) => {
      const environment = {
        PASEO_BOOTSTRAP_ORGANIZATION: "Fixture organization",
        PASEO_BOOTSTRAP_OWNER_EMAIL: "owner@example.test",
        PASEO_BOOTSTRAP_OWNER_PASSWORD: raw,
      };
      const password = readInstanceAuthPolicy(environment).bootstrap?.ownerPassword;
      expect(password).toBe(raw);
      expect(projectedError(password!, [])).toContain("pppppppppppp");
      expectProtected(environment, [raw, password!]);
    },
  );

  it("covers effective notification, progress and Discord credentials returned by their real readers", () => {
    const environment = {
      GITHUB_NOTIFICATIONS_TOKEN: "  notification-mmmmmmmmmmmm  ",
      PASEO_HUB_PROGRESS_GITHUB_TOKEN: "  progress-mmmmmmmmmmmm  ",
      DISCORD_BOT_TOKEN: "  discord-mmmmmmmmmmmm  ",
    };
    const values = [
      readGitHubNotificationsOptions(environment)!.token,
      readRunProgressSettings({
        ...environment,
        PASEO_HUB_PROGRESS_GITHUB_ORGS: "acme:owner/*",
      }).githubToken!,
      readDiscordOperatorAuth(environment)!.token,
    ];
    expectProtected(environment, [...Object.values(environment), ...values]);
  });

  it("preserves raw and effective provider credentials and private-key bytes loaded by the real reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-credential-reader-"));
    try {
      const keyPath = join(root, "private-key.pem");
      const privateKey = "loaded-private-mmmmmmmmmmmm";
      await writeFile(keyPath, privateKey, "utf8");
      const environment = {
        GITHUB_APP_ID: "1",
        GITHUB_APP_SLUG: "fixture-app",
        GITHUB_APP_CLIENT_ID: "github-client",
        GITHUB_APP_CLIENT_SECRET: "  github-client-mmmmmmmmmmmm  ",
        GITHUB_WEBHOOK_SECRET: "  github-webhook-mmmmmmmmmmmm  ",
        GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        SLACK_APP_ID: "slack-app",
        SLACK_CLIENT_ID: "slack-client",
        SLACK_CLIENT_SECRET: "  slack-client-mmmmmmmmmmmm  ",
        SLACK_SIGNING_SECRET: "  slack-signing-mmmmmmmmmmmm  ",
        DISCORD_CLIENT_ID: "discord-client",
        DISCORD_CLIENT_SECRET: "  discord-client-mmmmmmmmmmmm  ",
        DISCORD_BOT_TOKEN: "  discord-bot-mmmmmmmmmmmm  ",
        LINEAR_CLIENT_ID: "linear-client",
        LINEAR_CLIENT_SECRET: "  linear-client-mmmmmmmmmmmm  ",
        LINEAR_WEBHOOK_SECRET: "  linear-webhook-mmmmmmmmmmmm  ",
      };
      const configurations = Object.values(await readProviderApplicationEnvironment(environment));
      expect(configurations).toHaveLength(4);
      const collected = readTimelineScrubValues(environment, configurations);
      const effective = effectiveProviderCredentials(configurations);
      expect(effective).toContain(privateKey);
      for (const value of effective) {
        expect(collected).toContain(value);
        expect(projectedError(value, collected)).not.toContain(value);
      }
      expect(collected).not.toContain(keyPath);
      const socketEnvironment = {
        SLACK_TRANSPORT: "socket",
        SLACK_APP_ID: "slack-app",
        SLACK_APP_TOKEN: "  socket-mmmmmmmmmmmm  ",
      };
      const socket = await readProviderApplicationEnvironment(socketEnvironment);
      expect(socket.slack).toMatchObject({ appToken: "socket-mmmmmmmmmmmm" });
      expectProtected(socketEnvironment, [
        socketEnvironment.SLACK_APP_TOKEN,
        "socket-mmmmmmmmmmmm",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores absent and empty credentials and deduplicates collected values", () => {
    expect(
      readTimelineScrubValues({ RESEND_API_KEY: undefined, PASEO_BOOTSTRAP_OWNER_PASSWORD: "" }),
    ).toEqual([]);
    expect(
      readTimelineScrubValues({
        RESEND_API_KEY: "same-fixture",
        PASEO_HUB_AUTH_SECRET: "same-fixture",
      }),
    ).toEqual(["same-fixture"]);
  });
});
