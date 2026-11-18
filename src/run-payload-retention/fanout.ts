import { z } from "zod";
import { NormalizedGitHubEventSchema } from "../auth/github-events.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import type { ProviderEventReceiptRecord } from "../db/types.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../triggers/github/classification.js";
import { matchGitHubInvocations } from "../triggers/github/match.js";
import { NormalizedLinearEventSchema } from "../triggers/linear/events.js";
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
type PinnedRoute = z.infer<typeof pinnedRoute>;

export interface FanoutRevision {
  projectId: string;
  organizationId: string;
  normalizedConfiguration: unknown;
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
  const parsed = z.array(pinnedRoute).min(1).safeParse(receipt.acceptedRoutes);
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
    for (const route of routes) {
      const revision = revisionById(route.configurationRevisionId);
      if (
        revision?.projectId !== route.projectId ||
        revision.organizationId !== receipt.organizationId
      )
        return undefined;
      const names = expectedWorkflowNames(receipt, route, revision);
      if (names === undefined) return undefined;
      expected.push({
        projectId: route.projectId,
        configurationRevisionId: route.configurationRevisionId,
        names,
      });
    }
  } catch {
    return undefined;
  }
  return expected;
}

function expectedWorkflowNames(
  receipt: FanoutReceipt,
  route: PinnedRoute,
  revision: FanoutRevision,
) {
  const configuration = parseCompiledHubConfig(revision.normalizedConfiguration);
  if (configuration.environments.some((env) => env.kind === "daemon" && env.daemonId === undefined))
    return undefined;
  if (receipt.provider === "github") {
    const event = NormalizedGitHubEventSchema.parse(receipt.payload);
    if (
      receipt.source !== `github.${event.type}` ||
      !GITHUB_TRIGGER_SOURCE_NAMES.some((source) => source === receipt.source)
    )
      return undefined;
    const matches = matchGitHubInvocations(configuration, event, {
      source: receipt.source,
      connectionId: route.connectionId,
    });
    return typeof matches === "string" ? [] : matches.map((match) => match.triggerName);
  }

  const event = NormalizedLinearEventSchema.parse(receipt.payload);
  if (receipt.source !== `linear.${event.type}`) return undefined;
  if (!hasLinearSourceTrigger(configuration.triggers, receipt.source)) return [];
  if (linearInvocationUsesAppUser(event)) return undefined;
  return matchLinearInvocations(configuration, event, route.connectionId).map(
    (match) => match.triggerName,
  );
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
