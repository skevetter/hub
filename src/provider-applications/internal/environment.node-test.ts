import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readProviderApplicationEnvironment } from "./environment.js";

const github = {
  GITHUB_APP_ID: " 42 ",
  GITHUB_APP_SLUG: " app ",
  GITHUB_APP_CLIENT_ID: " client ",
  GITHUB_APP_CLIENT_SECRET: " secret ",
  GITHUB_WEBHOOK_SECRET: " webhook ",
};

function githubResult(privateKey: string) {
  return {
    github: {
      provider: "github",
      appId: "42",
      appSlug: "app",
      clientId: "client",
      clientSecret: "secret",
      webhookSecret: "webhook",
      privateKey,
    },
  };
}

void test("loads GitHub credentials only when the complete group and a nonempty key are present", async () => {
  for (const key of Object.keys(github)) {
    assert.deepEqual(
      await readProviderApplicationEnvironment({
        ...github,
        [key]: " ",
        GITHUB_APP_PRIVATE_KEY_PATH: "/not-present",
      }),
      {},
    );
  }
  assert.deepEqual(await readProviderApplicationEnvironment(github), {});
  assert.deepEqual(
    await readProviderApplicationEnvironment({
      ...github,
      GITHUB_APP_PRIVATE_KEY: " inline ",
      GITHUB_APP_PRIVATE_KEY_PATH: "/not-present",
    }),
    githubResult("inline"),
  );
});

void test("reads the GitHub key file verbatim and propagates file errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-app-environment-"));
  const path = join(dir, "private-key");
  const env = { ...github, GITHUB_APP_PRIVATE_KEY_PATH: path };
  try {
    await assert.rejects(readProviderApplicationEnvironment(env), { code: "ENOENT" });
    await writeFile(path, "");
    assert.deepEqual(await readProviderApplicationEnvironment(env), {});
    await writeFile(path, " key\n");
    assert.deepEqual(await readProviderApplicationEnvironment(env), githubResult(" key\n"));
  } finally {
    await rm(dir, { recursive: true });
  }
});

const slack = {
  SLACK_APP_ID: "A1",
  SLACK_CLIENT_ID: "client",
  SLACK_CLIENT_SECRET: "secret",
  SLACK_SIGNING_SECRET: "signing",
};
const socket = { SLACK_TRANSPORT: "socket", SLACK_APP_ID: "A1", SLACK_APP_TOKEN: "xapp-token" };

void test("distinguishes implicit webhook, explicit webhook, socket, and unset Slack groups", async () => {
  const webhook = {
    slack: {
      provider: "slack",
      transport: "webhook",
      appId: "A1",
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
    },
  };
  assert.deepEqual(await readProviderApplicationEnvironment({ SLACK_APP_ID: " " }), {});
  assert.deepEqual(await readProviderApplicationEnvironment(slack), webhook);
  assert.deepEqual(
    await readProviderApplicationEnvironment({ ...slack, SLACK_TRANSPORT: "webhook" }),
    webhook,
  );
  assert.deepEqual(await readProviderApplicationEnvironment(socket), {
    slack: { provider: "slack", transport: "socket", appId: "A1", appToken: "xapp-token" },
  });
});

void test("rejects incomplete, mixed, and unknown Slack groups with transport-specific errors", async () => {
  await assert.rejects(readProviderApplicationEnvironment({ ...slack, SLACK_TRANSPORT: "other" }), {
    message: "Slack environment configuration has an unknown SLACK_TRANSPORT value.",
  });
  for (const env of [
    { ...socket, SLACK_APP_ID: "" },
    { ...socket, SLACK_CLIENT_ID: "mixed" },
  ]) {
    await assert.rejects(readProviderApplicationEnvironment(env), {
      message:
        "Slack environment configuration for Socket Mode requires exactly SLACK_TRANSPORT=socket, SLACK_APP_ID, and SLACK_APP_TOKEN.",
    });
  }
  for (const env of [
    { ...slack, SLACK_CLIENT_SECRET: "" },
    { ...slack, SLACK_APP_TOKEN: "mixed" },
  ]) {
    await assert.rejects(readProviderApplicationEnvironment(env), {
      message:
        "Slack environment configuration for Webhooks requires SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_SIGNING_SECRET.",
    });
  }
});
