import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import type { Database } from "../db/types.js";
import type { SessionPrincipal } from "../interactive-sessions/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import type { AttentionSnapshot } from "./contract.js";
import { ATTENTION_WINDOW_DAYS, deriveAttention } from "./items.js";

export class AttentionDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly options: { interactiveSessions?: boolean; now?: () => Date } = {},
  ) {}

  async snapshot(request: Request, organizationSlug: string): Promise<AttentionSnapshot> {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const { id: organizationId, slug } = tenant.organization;
    const reader = { organizationId, userId: account.account.id, role: tenant.membership.role };
    const now = this.options.now?.() ?? new Date();
    const windowMs = ATTENTION_WINDOW_DAYS * 86_400_000;
    const since = new Date(now.getTime() - windowMs);
    const [connections, daemons, triggers, triggerMatches, dropped, failedRuns, sessions] =
      await Promise.all([
        this.database.organizationConnectionUsage(organizationId),
        this.database.listDaemonsForOrganization(organizationId),
        this.database.listOrganizationTriggers(organizationId),
        this.database.listTriggerMatchActivity(organizationId, {
          previousStart: new Date(now.getTime() - 2 * windowMs),
          recentStart: since,
          now,
        }),
        this.database.countRecentDroppedEvents(organizationId, since),
        this.failedRuns(reader, since),
        this.sessions(reader),
      ]);
    return {
      items: deriveAttention({
        organizationSlug: slug,
        now,
        connections,
        daemons,
        triggers,
        triggerMatches,
        dropped,
        failedRuns,
        sessions,
      }),
      generatedAt: now.toISOString(),
    };
  }

  async markFailedRunsSeen(request: Request, organizationSlug: string): Promise<void> {
    if (this.auth.rejectCookieMutation(request, { requireOrigin: true }) !== undefined)
      throw new ProductRequestError(400, "invalid_origin");
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    await this.database.markFailedRunsSeen(account.account.id, tenant.organization.id);
  }

  private async failedRuns({ organizationId, userId }: SessionPrincipal, since: Date) {
    const seenThrough = await this.database.readFailedRunsSeenThrough(userId, organizationId);
    return this.database.countFailedRunsSince(organizationId, since, seenThrough);
  }

  private async sessions(reader: SessionPrincipal) {
    if (this.options.interactiveSessions !== true) return null;
    const [hasActiveProfile, waiting] = await Promise.all([
      this.database.hasActiveSessionProfile(reader.organizationId),
      this.database.listSessionsWaitingForPermission(reader.organizationId, reader, 1),
    ]);
    return { hasActiveProfile, waiting };
  }
}
