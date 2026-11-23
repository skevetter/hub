import { describe, expect, it } from "vitest";
import { LINEAR_PILOT_ENV, linearPilotConfigFromEnv, parseLinearPilotConfig } from "./config.js";

const VALID = {
  hubOrganizationId: "hub-org-1",
  linearOrganizationId: "lin-org-2",
  allowedHumanId: "human-3",
  profileId: "6f1c2a9e-3b7d-4c58-9e0a-1d2f3a4b5c6d",
};

function invalid(raw: string) {
  const result = parseLinearPilotConfig(raw);
  if (result.status !== "invalid") throw new Error(`expected invalid, got ${result.status}`);
  return result.reason;
}

describe("parseLinearPilotConfig", () => {
  it("absent setting leaves the pilot inert", () => {
    expect(parseLinearPilotConfig(undefined)).toEqual({ status: "absent" });
    expect(linearPilotConfigFromEnv({})).toEqual({ status: "absent" });
  });

  it("reads exactly one strict record from the named setting", () => {
    const result = linearPilotConfigFromEnv({ [LINEAR_PILOT_ENV]: JSON.stringify(VALID) });
    expect(result).toEqual({ status: "enabled", config: VALID });
    if (result.status !== "enabled") throw new Error("expected enabled");
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  it("every malformed record fails closed with a value-free reason", () => {
    const withKey = (key: string, value: unknown) => JSON.stringify({ ...VALID, [key]: value });
    const dropped = JSON.stringify({ ...VALID, profileId: undefined });
    expect(invalid("")).toBe("empty");
    expect(invalid("   ")).toBe("empty");
    expect(invalid("{not json")).toBe("not_json");
    expect(invalid("[]")).toBe("not_a_record");
    expect(invalid("null")).toBe("not_a_record");
    expect(invalid('"text"')).toBe("not_a_record");
    expect(invalid(withKey("extra", "x"))).toBe("unknown_key");
    expect(invalid(withKey("enabled", true))).toBe("unknown_key");
    expect(invalid(dropped)).toBe("missing_key");
    expect(invalid("{}")).toBe("missing_key");
    for (const bad of ["", " lead", "trail ", "a b", "x".repeat(129), 7, null, true]) {
      expect(invalid(withKey("profileId", bad))).toBe("bad_value");
    }
    expect(invalid(withKey("profileId", 'q"uote'))).toBe("escape_sequence");
    expect(invalid(withKey("allowedHumanId", ["human-3"]))).toBe("bad_value");
  });

  it("rejects duplicate keys and escaped key spellings that JSON.parse would resolve silently", () => {
    const body = JSON.stringify(VALID);
    const duplicated = body.replace("}", `,"profileId":"0b9c1d2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"}`);
    const parsed: unknown = JSON.parse(duplicated);
    expect(parsed).toMatchObject({ profileId: "0b9c1d2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e" });
    expect(invalid(duplicated)).toBe("duplicate_key");
    expect(invalid(body.replace("profileId", "\\u0070rofileId"))).toBe("escape_sequence");
  });

  it("a value that spells a key name is not mistaken for a duplicate key", () => {
    const raw = JSON.stringify({ ...VALID, allowedHumanId: "profileId" });
    expect(parseLinearPilotConfig(raw).status).toBe("enabled");
  });

  it("the profile id must be a uuid and is normalized to lower case", () => {
    const withProfile = (value: unknown) => JSON.stringify({ ...VALID, profileId: value });
    for (const bad of [
      "profile-4",
      "6f1c2a9e3b7d4c589e0a1d2f3a4b5c6d",
      "6f1c2a9e-3b7d-4c58-9e0a-1d2f3a4b5c6",
      "6f1c2a9e-3b7d-4c58-9e0a-1d2f3a4b5c6dd",
      "g f1c2a9e-3b7d-4c58-9e0a-1d2f3a4b5c6d",
      "{6f1c2a9e-3b7d-4c58-9e0a-1d2f3a4b5c6d}",
    ]) {
      expect(invalid(withProfile(bad)), bad).toBe("bad_value");
    }
    const upper = parseLinearPilotConfig(withProfile(VALID.profileId.toUpperCase()));
    expect(upper).toEqual({ status: "enabled", config: VALID });
  });

  it.each([true, false])("accepts optional toolSteps: %s", (toolSteps) => {
    const config = { ...VALID, toolSteps };
    expect(parseLinearPilotConfig(JSON.stringify(config))).toEqual({ status: "enabled", config });
  });

  it("does not accept malformed or repeated toolSteps values", () => {
    for (const toolSteps of ["true", 0, null, {}])
      expect(invalid(JSON.stringify({ ...VALID, toolSteps }))).toBe("bad_value");
    const raw = JSON.stringify({ ...VALID, toolSteps: true });
    expect(invalid(raw.replace("}", ', "toolSteps" : false}'))).toBe("duplicate_key");
  });

  it("refuses oversized input before parsing", () => {
    expect(invalid(JSON.stringify({ ...VALID, profileId: "p".repeat(2_000) }))).toBe("too_large");
  });

  it("never echoes configured values in the outcome", () => {
    const secretish = "hub-org-DO-NOT-LEAK";
    const result = parseLinearPilotConfig(
      JSON.stringify({ ...VALID, hubOrganizationId: secretish, extra: 1 }),
    );
    expect(JSON.stringify(result)).not.toContain(secretish);
  });
});
