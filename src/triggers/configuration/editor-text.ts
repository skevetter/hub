import { z } from "zod";

const ProviderOptionsSchema = z.record(z.string(), z.unknown());
const GitHubPermissionsSchema = z.record(z.string(), z.enum(["read", "write", "admin"]));

export function incompleteReason(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "The trigger is invalid.";
}

export function parsePermissions(
  value: string,
): Record<string, "read" | "write" | "admin"> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GitHub permissions must be valid JSON.");
  }
  const permissions = GitHubPermissionsSchema.safeParse(parsed);
  if (!permissions.success) {
    throw new Error('GitHub permissions map a scope to "read", "write", or "admin".');
  }
  return permissions.data;
}

/** The message a parse refused with, or `undefined` when it accepted the value. */
export function refused(parse: () => unknown): string | undefined {
  try {
    parse();
    return undefined;
  } catch (cause) {
    return incompleteReason(cause);
  }
}

export function parseProviderOptions(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Provider options must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider options must be a JSON object.");
  }
  return ProviderOptionsSchema.parse(parsed);
}

export function joinAgentId(provider: string, model: string | undefined): string {
  return model === undefined ? provider : `${provider}/${model}`;
}

export function splitAgentId(value: string): { provider: string; model?: string } {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  if (separator < 0) {
    if (normalized.length === 0) throw new Error("Agent is required.");
    return { provider: normalized };
  }
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error("Agent must look like provider/model.");
  }
  return { provider, model };
}

export function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function blankToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
