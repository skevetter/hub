import { z } from "zod";

export const API_KEY_SCOPES = [
  "projects:read",
  "configuration:validate",
  "configuration:install",
  "runs:dispatch",
  "runs:read",
  "events:send",
  "daemons:enroll",
] as const;

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export const apiKeyScopesSchema = z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length);

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const apiKeyActorSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u);
export const apiKeyAllowedTriggersSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]*$/u))
  .max(50)
  .refine((names) => new Set(names).size === names.length, {
    message: "Allowed trigger names must be unique",
  });

export const apiKeyIdentitySchema = z.object({
  actor: apiKeyActorSchema.nullable().optional(),
  allowedTriggers: apiKeyAllowedTriggersSchema.nullable().optional(),
});

export type ApiKeyIdentityOptions = z.input<typeof apiKeyIdentitySchema>;

export function defaultApiKeyActor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
}

export const apiKeyCreateSchema = apiKeyIdentitySchema
  .extend({
    name: z.string().trim().min(1).max(100),
    scopes: apiKeyScopesSchema.refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "API key scopes must be unique",
    }),
  })
  .strict()
  .transform((input, context) => {
    const actor = input.actor === undefined ? defaultApiKeyActor(input.name) : input.actor;
    if (
      (actor !== null && !apiKeyActorSchema.safeParse(actor).success) ||
      (actor === null && input.scopes.includes("events:send"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Provide a valid actor for this API key",
      });
      return z.NEVER;
    }
    return { ...input, actor, allowedTriggers: input.allowedTriggers ?? null };
  });
