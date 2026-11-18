import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import {
  ApiKeyFormFields,
  ApiKeySecretContent,
  ApiKeyTable,
  ApiKeyTriggerField,
  GitHubSecretContent,
  apiKeyFormPayload,
  type ApiKeyRecord,
  type ApiKeyTriggerChoices,
  type ApiKeyWebhookSettings,
} from "./api-key-presentation.js";
import type { ApiKeyScope } from "./api-key-contract.js";

const triggers: ApiKeyTriggerChoices = {
  status: "success",
  data: { names: ["build-finished", "deploy-ready"] },
  error: null,
};

const noop = () => {};
const loading = { status: "pending", data: undefined, error: null } as const;
const unavailable = { status: "error", data: undefined, error: null } as const;
const emptyTriggers: ApiKeyTriggerChoices = {
  status: "success",
  data: { names: [] },
  error: null,
};
const webhookSettings: ApiKeyWebhookSettings = {
  status: "success",
  data: { baseUrl: "https://hub.example.test" },
  error: null,
};

const renderFields = (
  name: string,
  scopes: ApiKeyScope[] = ["events:send"],
  actorOverride?: string,
) =>
  renderToStaticMarkup(
    <ApiKeyFormFields
      name={name}
      actorOverride={actorOverride}
      scopes={scopes}
      triggers={triggers}
      scopeError={undefined}
      onNameChange={noop}
      onActorChange={noop}
      onScopeChange={noop}
    />,
  );

function form(scopes = ["events:send"], actor = "ci-partner") {
  const data = new FormData();
  data.set("name", "CI Partner");
  data.set("actor", actor);
  for (const scope of scopes) data.append("scopes", scope);
  return data;
}

const record: ApiKeyRecord = {
  id: "legacy-key",
  name: "Legacy key",
  prefix: "paseo_pk_example",
  scopes: ["runs:dispatch"],
  actor: null,
  allowedTriggers: null,
  createdAt: "2026-11-14T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

const renderTable = (records: ApiKeyRecord[]) =>
  renderToStaticMarkup(
    <ApiKeyTable records={records} canManage={false} busy={false} onRevoke={noop} />,
  );

function input(markup: string, name: string): string {
  return (
    [...markup.matchAll(/<input\b[^>]*>/gu)]
      .map(([element]) => element)
      .find((element) => element.includes(`name="${name}"`)) ?? ""
  );
}

describe("API key form", () => {
  it("reactively derives the actor from the name until the user overrides it", () => {
    assert.match(input(renderFields("CI Partner"), "actor"), /value="ci-partner"/u);
    assert.match(input(renderFields("Deploy Worker"), "actor"), /value="deploy-worker"/u);
    assert.match(
      input(renderFields("Deploy Worker", ["events:send"], "custom.actor"), "actor"),
      /value="custom.actor"/u,
    );
    assert.match(
      input(renderFields("Different name", ["events:send"], "custom.actor"), "actor"),
      /value="custom.actor"/u,
    );
    assert.match(input(renderFields("CI Partner", ["events:send"], ""), "actor"), /value=""/u);
  });

  it("offers Send events and requires an actor only for that scope", () => {
    const markup = renderFields("CI Partner");
    assert.match(markup, /Send events/u);
    assert.match(markup, /name="scopes"[^>]*value="events:send"/u);
    assert.match(input(markup, "actor"), /required=""/u);
    assert.match(input(markup, "actor"), /maxLength="63"/u);
    assert.doesNotMatch(
      input(renderFields("CI Partner", ["projects:read"]), "actor"),
      /required=/u,
    );
  });

  it("submits the read-only timeline scope without granting dispatch", () => {
    const markup = renderFields("Timeline reader", ["runs:read"]);
    assert.match(markup, /Read run timelines/u);
    const checkbox = [...markup.matchAll(/<input\b[^>]*>/gu)].find(([element]) =>
      element.includes('value="runs:read"'),
    )?.[0];
    assert.ok(checkbox);
    assert.match(checkbox, /checked=""/u);
    const result = apiKeyFormPayload(form(["runs:read"]));
    assert.equal(result.success, true);
    if (result.success) assert.deepEqual(result.data.scopes, ["runs:read"]);
  });

  it("renders the reusable checkbox list with empty selection meaning any allowed actor trigger", () => {
    const markup = renderToStaticMarkup(<ApiKeyTriggerField triggers={triggers} />);
    assert.match(markup, /Allowed triggers/u);
    assert.match(markup, /Leave the selection empty to allow any trigger this actor may reach/u);
    assert.match(markup, /type="checkbox"/u);
    assert.match(markup, /name="allowedTriggers"[^>]*value="build-finished"/u);
    assert.match(markup, /name="allowedTriggers"[^>]*value="deploy-ready"/u);
  });

  it("disables the trigger field while loading", () => {
    const markup = renderToStaticMarkup(<ApiKeyTriggerField triggers={loading} />);
    assert.match(input(markup, "allowedTriggers"), /disabled=""/u);
    assert.match(markup, /Loading triggers\.\.\./u);
  });

  it("offers an editable names fallback and a meaningful list failure", () => {
    const markup = renderToStaticMarkup(<ApiKeyTriggerField triggers={unavailable} />);
    assert.match(markup, /Triggers unavailable/u);
    assert.match(markup, /Hub did not receive the trigger list/u);
    assert.match(markup, /enter trigger names below/u);
    assert.match(markup, /separated by commas or spaces/u);
    assert.match(input(markup, "allowedTriggers"), /type="text"/u);
    assert.doesNotMatch(input(markup, "allowedTriggers"), /disabled=/u);
  });

  it("shows trigger creation guidance without blocking key creation", () => {
    const markup = renderToStaticMarkup(<ApiKeyTriggerField triggers={emptyTriggers} />);
    assert.match(markup, /No webhook triggers/u);
    assert.match(markup, /Create a manual\.run trigger first/u);
    assert.match(markup, /You can still create this key now/u);
    assert.doesNotMatch(markup, /required=|disabled=/u);
  });

  it("creates an explicit identity and converts empty selection to null, never deny-all", () => {
    const result = apiKeyFormPayload(form());
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.actor, "ci-partner");
    assert.deepEqual(result.data.scopes, ["events:send"]);
    assert.equal(result.data.allowedTriggers, null);
  });

  it("submits selected names and accepts future trigger names from the fallback", () => {
    const selected = form();
    selected.append("allowedTriggers", "build-finished");
    selected.append("allowedTriggers", "deploy-ready");
    const fallback = form();
    fallback.set("allowedTriggers", "build-finished, deploy-ready\nfuture-trigger");
    const selectedResult = apiKeyFormPayload(selected);
    const fallbackResult = apiKeyFormPayload(fallback);
    assert.equal(selectedResult.success, true);
    assert.equal(fallbackResult.success, true);
    if (selectedResult.success) {
      assert.deepEqual(selectedResult.data.allowedTriggers, ["build-finished", "deploy-ready"]);
    }
    if (fallbackResult.success) {
      assert.deepEqual(fallbackResult.data.allowedTriggers, [
        "build-finished",
        "deploy-ready",
        "future-trigger",
      ]);
    }
  });

  it("enforces the actor, scope and trigger constraints before submitting", () => {
    assert.equal(apiKeyFormPayload(form([], "ci-partner")).success, false);
    assert.equal(apiKeyFormPayload(form(["events:send"], "")).success, false);
    assert.equal(apiKeyFormPayload(form(["events:send"], "Bad Actor")).success, false);
    assert.equal(apiKeyFormPayload(form(["events:send"], ".invalid-start")).success, false);
    assert.equal(apiKeyFormPayload(form(["events:send"], "a".repeat(64))).success, false);
    const actorless = apiKeyFormPayload(form(["projects:read"], ""));
    assert.equal(actorless.success, true);
    if (actorless.success) assert.equal(actorless.data.actor, null);
    for (const names of [
      "Bad Trigger",
      "build-finished, build-finished",
      Array.from({ length: 51 }, (_, index) => `trigger-${index}`).join(","),
    ]) {
      const data = form();
      data.set("allowedTriggers", names);
      assert.equal(apiKeyFormPayload(data).success, false);
    }
  });
});

describe("API key table", () => {
  it("shows actor and trigger columns and identifies legacy actorless keys", () => {
    const markup = renderTable([record]);
    assert.match(markup, />Actor</u);
    assert.match(markup, />Triggers</u);
    assert.match(markup, />none</u);
    assert.match(markup, />All</u);
  });

  it("distinguishes unrestricted keys, deny-all keys and named restrictions", () => {
    const markup = renderTable([
      record,
      {
        ...record,
        id: "deny-all",
        name: "Restricted key",
        actor: "ci-partner",
        allowedTriggers: [],
      },
      {
        ...record,
        id: "selected",
        scopes: ["events:send"],
        actor: "build-worker",
        allowedTriggers: ["build-finished", "deploy-ready"],
      },
    ]);
    assert.match(markup, />All</u);
    assert.match(markup, />None</u);
    assert.match(markup, />ci-partner</u);
    assert.match(markup, />build-worker</u);
    assert.match(markup, /build-finished, deploy-ready/u);
    assert.match(markup, /Send events/u);
  });
});

describe("one-time API key presentation", () => {
  it("keeps the one-time secret separate from the placeholder curl using the configured origin", () => {
    const secret = "paseo_pk_fake_only_once";
    const markup = renderToStaticMarkup(
      <ApiKeySecretContent secret={secret} settings={webhookSettings} />,
    );
    assert.match(markup, /This secret cannot be recovered/u);
    assert.equal(markup.split(secret).length - 1, 1);
    assert.match(markup, /Generated API key/u);
    const sample = markup.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/u)?.[0];
    assert.ok(sample);
    assert.match(sample, /https:\/\/hub\.example\.test\/api\/v1\/hooks\/your-trigger-name/u);
    assert.match(sample, /Authorization: Bearer \$HUB_KEY/u);
    assert.doesNotMatch(sample, /paseo_pk_/u);
    assert.match(markup, /Copy curl/u);
  });

  it("keeps the secret available while the webhook address is loading", () => {
    const markup = renderToStaticMarkup(
      <ApiKeySecretContent secret="fake-secret" settings={loading} />,
    );
    assert.match(markup, /fake-secret/u);
    assert.match(markup, /Loading webhook address/u);
    assert.doesNotMatch(markup, /curl -sS|\/api\/v1\/hooks\//u);
  });

  it("shows an address failure without fabricating a URL or losing the secret", () => {
    const markup = renderToStaticMarkup(
      <ApiKeySecretContent secret="fake-secret" settings={unavailable} />,
    );
    assert.match(markup, /fake-secret/u);
    assert.match(markup, /Webhook example unavailable/u);
    assert.match(markup, /Hub did not receive the webhook address/u);
    assert.doesNotMatch(markup, /curl -sS|\/api\/v1\/hooks\//u);
  });
});

const keyId = "5bc27548-a159-4d3b-a85a-ff5713fde2cc";
const targetTriggerId = "d79c7455-a094-481e-aad2-ecfd6178ecf1";
const signingSecret = "paseo_whsec_fake-browser-test-secret";

const issued = { signingSecret, trigger: "build-finished", keyId };
const signedRecord: ApiKeyRecord = {
  ...record,
  id: keyId,
  actor: "sender",
  scopes: ["events:send"],
  allowedTriggers: ["build-finished"],
  authentication: {
    mode: "hmac",
    profile: "github_sha256",
    targetTriggerId,
    currentVersionId: keyId,
    previousVersionId: targetTriggerId,
    previousAcceptUntil: "2000-01-01T00:00:00.000Z",
  },
};
const records = [signedRecord];

describe("GitHub signing keys", () => {
  it("requires a selected trigger id and submits only the fixed scope", () => {
    const fields = form(["runs:read"]);
    assert.equal(apiKeyFormPayload(fields, true).success, false);
    fields.set("targetTriggerId", targetTriggerId);
    const payload = apiKeyFormPayload(fields, true);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.authentication, {
      mode: "hmac",
      profile: "github_sha256",
      targetTriggerId,
    });
    assert.deepEqual(payload.data.scopes, ["events:send"]);
    assert.equal(payload.data.allowedTriggers, null);
  });

  it("renders copy controls only in the reveal and expiry metadata in the table", () => {
    const reveal = renderToStaticMarkup(
      <GitHubSecretContent settings={webhookSettings} reveal={issued} />,
    );

    assert.match(reveal, /Copy signing secret/u);
    assert.match(reveal, /hub.example.test\/api\/v1\/hooks\/build-finished\/signers\//u);
    assert.ok(reveal.includes(signingSecret));
    const disabled = renderTable(records);
    assert.match(disabled, /Signature authentication disabled/u);
    assert.ok(!disabled.includes(signingSecret));
    assert.ok(!disabled.includes(signedRecord.prefix));
    const enabled = renderToStaticMarkup(
      <ApiKeyTable
        records={records}
        canManage={false}
        busy={false}
        onRevoke={noop}
        signingAvailability="enabled"
      />,
    );
    assert.match(enabled, /Previous version expired/u);
  });
});
