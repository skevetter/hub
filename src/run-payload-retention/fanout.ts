import { z } from "zod";
import { NormalizedGitHubEventSchema, type NormalizedGitHubEvent } from "../auth/github-events.js";
import { parseCompiledHubConfig, type CompiledHubConfig } from "../config/compiler.js";
import type { ProviderEventReceiptRecord } from "../db/types.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../triggers/github/classification.js";
import { matchGitHubInvocations } from "../triggers/github/match.js";
import {
  NormalizedLinearEventSchema,
  type NormalizedLinearEvent,
} from "../triggers/linear/events.js";
import {
  hasLinearSourceTrigger,
  linearInvocationUsesAppUser,
  matchLinearInvocations,
} from "../triggers/linear/match.js";

const routeKey = z.object({ projectId: z.guid(), configurationRevisionId: z.guid() });
const pinnedRoute = routeKey.extend({
  connectionId: z.string().nullable(),
  resourceId: z.string().nullable(),
});

export type FanoutReceipt = Pick<
  ProviderEventReceiptRecord,
  "id" | "organizationId" | "provider" | "payload" | "source"
> & {
  acceptedRoutes: unknown;
};

type RouteKey = z.infer<typeof routeKey>;
export type PinnedRoute = z.infer<typeof pinnedRoute>;

export interface FanoutRevision {
  projectId: string;
  organizationId: string;
  normalizedConfiguration: unknown;
  sourceEvidence?: unknown;
}

export type ExpectedFanout = readonly (RouteKey & { names: readonly string[] | null })[];

export interface AdmittedBranch extends RouteKey {
  configuredTriggerName: string;
}

export function usesPinnedFanout(provider: FanoutReceipt["provider"]): boolean {
  return (
    provider === "github" || provider === "linear" || provider === "slack" || provider === "discord"
  );
}

export function readPinnedRoutes(receipt: FanoutReceipt): PinnedRoute[] | undefined {
  if (!usesPinnedFanout(receipt.provider)) return [];
  return parsePinnedRoutes(receipt.acceptedRoutes);
}

export function parsePinnedRoutes(value: unknown): PinnedRoute[] | undefined {
  const parsed = z.array(pinnedRoute).min(1).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function expectedFanout(
  receipt: FanoutReceipt,
  revisionById: (id: string) => FanoutRevision | undefined,
): ExpectedFanout | undefined {
  if (!usesPinnedFanout(receipt.provider)) {
    const parsed = z.array(routeKey).safeParse(receipt.acceptedRoutes ?? []);
    return parsed.success
      ? parsed.data.map(({ projectId, configurationRevisionId }) => ({
          projectId,
          configurationRevisionId,
          names: null,
        }))
      : undefined;
  }
  if (receipt.provider === "slack" || receipt.provider === "discord") return undefined;
  const routes = readPinnedRoutes(receipt);
  if (routes === undefined) return undefined;

  const expected: (RouteKey & { names: readonly string[] })[] = [];
  try {
    const event = readPinnedProviderEvent(receipt);
    if (event === undefined) return undefined;
    for (const route of routes) {
      const config = pinnedConfiguration(
        revisionById(route.configurationRevisionId),
        receipt.organizationId,
        route,
      );
      if (config === undefined) return undefined;
      const matches = matchPinnedProviderInvocations(config, event, receipt.source, route);
      if (matches === undefined) return undefined;
      expected.push({
        projectId: route.projectId,
        configurationRevisionId: route.configurationRevisionId,
        names: matches.map(({ triggerName }) => triggerName),
      });
    }
  } catch {
    return undefined;
  }
  return expected;
}

export function pinnedConfiguration(
  revision: FanoutRevision | undefined,
  organizationId: string,
  route: PinnedRoute,
) {
  if (revision?.projectId !== route.projectId || revision.organizationId !== organizationId)
    return undefined;
  const config = parseCompiledHubConfig(revision.normalizedConfiguration);
  return config.environments.some((env) => env.kind === "daemon" && env.daemonId === undefined)
    ? undefined
    : config;
}

export type PinnedProviderEvent =
  | { provider: "github"; event: NormalizedGitHubEvent }
  | { provider: "linear"; event: NormalizedLinearEvent };

export function readPinnedProviderEvent(receipt: FanoutReceipt): PinnedProviderEvent | undefined {
  if (receipt.provider === "github") {
    const parsed = NormalizedGitHubEventSchema.safeParse(receipt.payload);
    if (!parsed.success) return undefined;
    const event = parsed.data;
    if (
      receipt.source !== `github.${event.type}` ||
      !GITHUB_TRIGGER_SOURCE_NAMES.some((source) => source === receipt.source)
    )
      return undefined;
    return { provider: "github", event };
  }
  if (receipt.provider !== "linear") return undefined;
  const parsed = NormalizedLinearEventSchema.safeParse(receipt.payload);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  return receipt.source === `linear.${event.type}` ? { provider: "linear", event } : undefined;
}

export function matchPinnedProviderInvocations(
  configuration: CompiledHubConfig,
  { provider, event }: PinnedProviderEvent,
  source: string,
  route: PinnedRoute,
) {
  if (provider === "github") {
    const matches = matchGitHubInvocations(configuration, event, {
      source,
      connectionId: route.connectionId,
    });
    return typeof matches === "string" ? [] : matches;
  }
  if (!hasLinearSourceTrigger(configuration.triggers, source)) return [];
  if (linearInvocationUsesAppUser(event)) return undefined;
  return matchLinearInvocations(configuration, event, route.connectionId);
}

export function coversExpectedFanout(
  expectation: ExpectedFanout | undefined,
  branches: readonly AdmittedBranch[],
): boolean {
  return (
    expectation !== undefined &&
    expectation.every((route) => {
      const names = new Set(
        branches
          .filter(
            (branch) =>
              branch.projectId === route.projectId &&
              branch.configurationRevisionId === route.configurationRevisionId,
          )
          .map((branch) => branch.configuredTriggerName),
      );
      return route.names === null ? names.size > 0 : route.names.every((name) => names.has(name));
    })
  );
}
