import { describe, expect, it } from "vitest";
import { deriveSigningSecret, readWebhookSigningSettings } from "./webhook-signatures.js";

const prefix = "PASEO_HUB_WEBHOOK_";
const master = Buffer.alloc(32, 1);
const encoded = master.toString("base64");
const salt = Buffer.alloc(32, 2).toString("base64url");

describe("webhook signing configuration", () => {
  it("preserves configured organization and key order", () => {
    const result = readWebhookSigningSettings({
      [`${prefix}HMAC_ENABLED`]: "true",
      [`${prefix}GITHUB_SIGNATURES_ENABLED`]: "true",
      [`${prefix}HMAC_ORGANIZATION_IDS`]: '["a_B","org-2"]',
      [`${prefix}HMAC_KEYRING`]: JSON.stringify({ z: encoded, a: encoded }),
      [`${prefix}HMAC_ACTIVE_KEY_ID`]: "z",
    });
    expect(result).toEqual({
      enabled: true,
      githubEnabled: true,
      organizationIds: new Set(["a_B", "org-2"]),
      keyring: new Map([
        ["z", master],
        ["a", master],
      ]),
      activeKeyId: "z",
    });
    expect([...result.keyring.keys()]).toEqual(["z", "a"]);
  });

  it("permits disabled signing with a configured active key", () => {
    const result = readWebhookSigningSettings({
      [`${prefix}HMAC_ENABLED`]: "",
      [`${prefix}GITHUB_SIGNATURES_ENABLED`]: "false",
      [`${prefix}HMAC_KEYRING`]: JSON.stringify({ z: encoded }),
      [`${prefix}HMAC_ACTIVE_KEY_ID`]: "z",
    });
    expect(result.enabled).toBe(false);
    expect(result.githubEnabled).toBe(false);
    expect(result.activeKeyId).toBe("z");
  });

  it("rejects malformed configuration with fixed messages", () => {
    for (const [setting, value, diagnostic] of [
      ["HMAC_ENABLED", "TRUE", "must be true or false."],
      ["GITHUB_SIGNATURES_ENABLED", "true", `requires ${prefix}HMAC_ENABLED.`],
      ["HMAC_ORGANIZATION_IDS", "{", "must contain valid JSON."],
      ["HMAC_ORGANIZATION_IDS", "{}", "must be a JSON array of distinct organization ids."],
      ["HMAC_ORGANIZATION_IDS", "[0]", "must be a JSON array of distinct organization ids."],
      ["HMAC_ORGANIZATION_IDS", '["!"]', "must be a JSON array of distinct organization ids."],
      ["HMAC_ORGANIZATION_IDS", '["a","a"]', "must be a JSON array of distinct organization ids."],
      ["HMAC_KEYRING", "null", "must be a JSON object."],
      ["HMAC_KEYRING", "42", "must be a JSON object."],
      ["HMAC_KEYRING", "[]", "must be a JSON object."],
      ["HMAC_KEYRING", '{"a":0,"b":0,"c":0}', "supports at most two online keys."],
      [
        "HMAC_KEYRING",
        JSON.stringify({ "!": encoded }),
        "requires key ids and canonical base64 32-byte keys.",
      ],
      ["HMAC_KEYRING", '{"a":0}', "requires key ids and canonical base64 32-byte keys."],
      ["HMAC_KEYRING", '{"a":""}', "requires key ids and canonical base64 32-byte keys."],
      [
        "HMAC_KEYRING",
        JSON.stringify({ a: encoded.slice(0, -1) }),
        "requires key ids and canonical base64 32-byte keys.",
      ],
      ["HMAC_ACTIVE_KEY_ID", "", "must select a configured key."],
    ] as const) {
      expect(() => readWebhookSigningSettings({ [`${prefix}${setting}`]: value })).toThrow(
        `${prefix}${setting} ${diagnostic}`,
      );
    }
    expect(() => readWebhookSigningSettings({ [`${prefix}HMAC_ENABLED`]: "true" })).toThrow(
      `${prefix}HMAC_ACTIVE_KEY_ID must select a configured key.`,
    );
  });
});

describe("webhook signing derivation", () => {
  it("matches the legacy vector and rejects malformed material", () => {
    expect(deriveSigningSecret(master, "master", salt, "org", "key", "version")).toBe(
      "paseo_whsec_pIDTVUUhAkezxGDiOD-3yuvg73uwNTfDk3y0O1LMe80",
    );
    for (const [inputMaster, inputSalt] of [
      [Buffer.alloc(31), salt],
      [master, ""],
      [master, `${salt}=`],
    ] as const) {
      expect(() =>
        deriveSigningSecret(inputMaster, "master", inputSalt, "org", "key", "version"),
      ).toThrow("Invalid webhook signing material");
    }
  });
});
