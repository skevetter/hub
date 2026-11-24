import { z } from "zod";

export const organizationSlugSchema = z.string().trim().min(1).max(100);

const routeBodySchema = z.looseObject({ organizationSlug: organizationSlugSchema });

/**
 * Splits the route organization off a body before the operation's own strict schema runs, so
 * that schema stays the one contract for the operation and a missing slug fails like any other
 * invalid field. Returns undefined when either part is invalid.
 */
export function splitRouteOrganization<TSchema extends z.ZodType>(
  body: unknown,
  schema: TSchema,
): { organizationSlug: string; input: z.output<TSchema> } | undefined {
  const route = routeBodySchema.safeParse(body);
  if (!route.success) return undefined;
  const { organizationSlug, ...rest } = route.data;
  const parsed = schema.safeParse(rest);
  return parsed.success ? { organizationSlug, input: parsed.data } : undefined;
}

/** Server function validator for operations that act on the organization in the address. */
export function routeOrganizationInput<TSchema extends z.ZodType>(schema: TSchema) {
  return (
    data: { organizationSlug: string } & z.input<TSchema>,
  ): { organizationSlug: string; input: z.output<TSchema> } => {
    const split = splitRouteOrganization(data, schema);
    if (split === undefined) throw new Error("Invalid request");
    return split;
  };
}

/** A server function's input once the hook, not the caller, supplies the route organization. */
export interface RouteInput<TInput extends { data: { organizationSlug: string } }> {
  data: Omit<TInput["data"], "organizationSlug">;
}
