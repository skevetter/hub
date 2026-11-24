import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { TOKEN_REVOKE_WATCHDOG_MS } from "../auth/revocation-budget.js";
import type { CompiledGitHubAuthority } from "../config/github-authority.js";
import {
  parseConnectionTemplate,
  resolveConnectionTemplate,
} from "../config/connection-template.js";
import type {
  ConnectionResolver,
  ConnectionResolutionContext,
  ConnectionTokenLease,
} from "../config/connections.js";
import type { Database } from "../db/types.js";
import type { GitHubAuthorityRegistration } from "../providers/registration.js";
import { reportFailure } from "../failures/index.js";
import type { ExecutionCredentialLease } from "./internal/store.js";
export { ExecutionAuthorityRepository } from "./internal/store.js";
export type {
  ExecutionAuthorityStore,
  ExecutionAuthorityRecord,
  ExecutionCredentialLease,
} from "./internal/store.js";

const REVOCATION_RETRY_BASE_DELAY_MS = 1_000;

export interface ExecutionAuthorityClock {
  now(): number;
  schedule(callback: () => Promise<void>, delayMs: number, options?: { ref?: boolean }): () => void;
}
const systemClock: ExecutionAuthorityClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(() => void callback(), delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
export interface ExecutionAuthorityMaterialization {
  executionId: string;
  projectId: string;
  triggerContext: unknown;
  env?: Readonly<Record<string, string>> | undefined;
  github?: CompiledGitHubAuthority | undefined;
}
export interface MaterializedExecutionAuthority {
  env: Record<string, string>;
}
export interface ExecutionAuthority {
  materialize(input: ExecutionAuthorityMaterialization): Promise<MaterializedExecutionAuthority>;
  canResume(input: ExecutionAuthorityMaterialization): Promise<boolean>;
  recover(): Promise<void>;
  onExecutionTerminal(executionId: string): Promise<void>;
  resourceCounts(): ExecutionAuthorityResourceCounts;
  stop(): Promise<void>;
}
export interface ExecutionAuthorityResourceCounts {
  executionStates: number;
  leases: number;
  pendingMaterializations: number;
}
export interface CreateExecutionAuthorityOptions {
  database: Pick<
    Database,
    | "executionAuthority"
    | "withAdvisoryLock"
    | "findAgentExecutionById"
    | "listAgentSessionExecutions"
  >;
  connectionsForProject: (projectId: string) => ConnectionResolver;
  githubAuthority?: GitHubAuthorityRegistration | undefined;
  clock?: ExecutionAuthorityClock | undefined;
  isExecutionActive: (executionId: string) => Promise<boolean>;
  logger?: Pick<Logger, "warn" | "error">;
}

interface PendingMaterialization {
  count: number;
  terminal: boolean;
}

interface AuthorityState {
  options: CreateExecutionAuthorityOptions;
  clock: ExecutionAuthorityClock;
  store: CreateExecutionAuthorityOptions["database"]["executionAuthority"];
  timers: Map<string, { executionId: string; cancel: () => void }>;
  pending: Map<string, PendingMaterialization>;
  stopped: boolean;
}

/** Owns issuance, durable lease recovery, and revocation independently of Hub process lifetime. */
export function createExecutionAuthority(
  options: CreateExecutionAuthorityOptions,
): ExecutionAuthority {
  const authority: AuthorityState = {
    options,
    clock: options.clock ?? systemClock,
    store: options.database.executionAuthority,
    timers: new Map(),
    pending: new Map(),
    stopped: false,
  };
  return {
    materialize: (input) => materialize(authority, input),
    canResume: (input) => canResume(authority, input),
    recover: () => recover(authority),
    onExecutionTerminal: (executionId) => onExecutionTerminal(authority, executionId),
    resourceCounts: () => resourceCounts(authority),
    async stop() {
      authority.stopped = true;
      for (const timer of authority.timers.values()) timer.cancel();
      authority.timers.clear();
    },
  };
}

async function materialize(
  authority: AuthorityState,
  input: ExecutionAuthorityMaterialization,
): Promise<MaterializedExecutionAuthority> {
  const { options, pending, store } = authority;
  if (authority.stopped) throw authorityStoppedError();
  const state = pending.get(input.executionId) ?? { count: 0, terminal: false };
  state.count++;
  pending.set(input.executionId, state);
  const ownedLeases: string[] = [];
  try {
    await assertActive(authority, input, state);
    const existing = await store.read(input.executionId);
    if (existing) {
      if (!(await canResume(authority, input))) throw unavailableCredentialsError();
      await assertActive(authority, input, state);
      return { env: existing.env };
    }
    const registration = { authority, input, state, ownedLeases };
    const register = (credential: ConnectionTokenLease, durationMs?: number) =>
      registerToken(registration, credential, durationMs);
    const env = Object.fromEntries(await resolveEnvironment(options, input, register));
    if (hasGitHubAuthority(input)) {
      const github = await mintGitHubAuthority(options, input);
      await register(
        { provider: "github", token: github.token, expiresAt: github.expiresAt },
        input.github.durationMs,
      );
      Object.assign(env, githubEnvironment(github.botUserId, github.botLogin, github.token));
    }
    await assertActive(authority, input, state);
    // A concurrent launch may have won. Keep its environment and revoke only our unused tokens.
    const committed = await store.commit({
      executionId: input.executionId,
      env,
      leaseIds: ownedLeases,
    });
    const unused = ownedLeases.filter((id) => !committed.leaseIds.includes(id));
    await releaseOwned(authority, input.executionId, unused);
    await assertActive(authority, input, state);
    return { env: committed.env };
  } catch (error) {
    const committed = await store.read(input.executionId);
    if (state.terminal || !(await options.isExecutionActive(input.executionId))) {
      await onExecutionTerminal(authority, input.executionId);
    } else {
      // A stopped worker must preserve credentials already committed for delivery.
      await releaseOwned(
        authority,
        input.executionId,
        ownedLeases.filter((id) => !committed?.leaseIds.includes(id)),
      );
    }
    throw error;
  } finally {
    state.count--;
    if (state.count === 0) pending.delete(input.executionId);
  }
}

async function assertActive(
  authority: AuthorityState,
  input: ExecutionAuthorityMaterialization,
  state: PendingMaterialization,
): Promise<void> {
  if (authority.stopped) throw authorityStoppedError();
  if (
    state.terminal ||
    !(await authority.options.isExecutionActive(input.executionId)) ||
    state.terminal
  ) {
    throw terminalExecutionError(input.executionId);
  }
  if (authority.stopped) throw authorityStoppedError();
}

interface LeaseRegistration {
  authority: AuthorityState;
  input: ExecutionAuthorityMaterialization;
  state: PendingMaterialization;
  ownedLeases: string[];
}

async function registerToken(
  { authority, input, state, ownedLeases }: LeaseRegistration,
  credential: ConnectionTokenLease,
  durationMs?: number,
): Promise<void> {
  const { clock, store } = authority;
  const lease: ExecutionCredentialLease = {
    id: randomUUID(),
    executionId: input.executionId,
    ...credential,
    deadlineAt: Math.min(
      credential.expiresAt,
      durationMs === undefined ? credential.expiresAt : clock.now() + durationMs,
    ),
    revoking: false,
    attempts: 0,
    nextAttemptAt: 0,
  };
  // Registration completes durably before a token can enter an agent environment.
  try {
    await store.saveLease(lease);
  } catch (error) {
    await revokeToken(authority, lease);
    throw error;
  }
  ownedLeases.push(lease.id);
  schedule(authority, lease);
  if (state.terminal || authority.stopped) {
    await release(authority, lease, true);
    throw authority.stopped ? authorityStoppedError() : terminalExecutionError(input.executionId);
  }
}

function resolveEnvironment(
  options: CreateExecutionAuthorityOptions,
  input: ExecutionAuthorityMaterialization,
  register: NonNullable<ConnectionResolutionContext["registerToken"]>,
): Promise<[string, string][]> {
  const context: ConnectionResolutionContext = {
    executionId: input.executionId,
    registerToken: register,
  };
  const resolver = cacheConnectionValues(options.connectionsForProject(input.projectId));
  return Promise.all(
    Object.entries(input.env ?? {}).map(
      async ([key, value]): Promise<[string, string]> => [
        key,
        await resolveConnectionTemplate(value, resolver, context, `step env.${key}`),
      ],
    ),
  );
}

function cacheConnectionValues(resolver: ConnectionResolver): ConnectionResolver {
  const resolved = new Map<string, Promise<string>>();
  return (slug, name, resolutionContext) => {
    const reference = `${slug}:${name}`;
    let result = resolved.get(reference);
    if (!result) {
      result = Promise.resolve(resolver(slug, name, resolutionContext));
      resolved.set(reference, result);
    }
    return result;
  };
}

function mintGitHubAuthority(
  options: CreateExecutionAuthorityOptions,
  input: ExecutionAuthorityMaterialization & { github: CompiledGitHubAuthority },
) {
  if (!options.githubAuthority)
    throw authorityError("github_authority_unavailable", "GitHub step authority is unavailable");
  return options.githubAuthority.mint({
    projectId: input.projectId,
    connectionSlug: input.github.connection,
    repositories: repositoriesForAuthority(input.github, input.triggerContext),
    permissions: input.github.permissions,
  });
}

function hasGitHubAuthority(
  input: ExecutionAuthorityMaterialization,
): input is ExecutionAuthorityMaterialization & { github: CompiledGitHubAuthority } {
  return Boolean(input.github);
}

async function releaseOwned(authority: AuthorityState, executionId: string, ids: string[]) {
  const { store } = authority;
  const leases = await store.leases(executionId);
  await Promise.all(
    leases
      .filter((lease) => ids.includes(lease.id))
      .map((lease) => release(authority, lease, true)),
  );
}

async function canResume(
  authority: AuthorityState,
  input: ExecutionAuthorityMaterialization,
): Promise<boolean> {
  const { store, clock } = authority;
  if (
    input.github === undefined &&
    !Object.values(input.env ?? {}).some((value) => parseConnectionTemplate(value).length > 0)
  )
    return true;
  if (authority.stopped) return false;
  const record = await store.read(input.executionId);
  if (!record) return false;
  const leases = await store.leases(input.executionId);
  const valid = record.leaseIds.every((id) =>
    leases.some((lease) => lease.id === id && !lease.revoking && lease.deadlineAt > clock.now()),
  );
  if (valid) for (const lease of leases) schedule(authority, lease);
  return valid;
}

async function authorityIsInUse(authority: AuthorityState, executionId: string): Promise<boolean> {
  const { options } = authority;
  if (await options.isExecutionActive(executionId)) return true;
  const execution = await options.database.findAgentExecutionById(executionId);
  if (!execution?.agentSessionId) return false;
  const requests = await options.database.listAgentSessionExecutions(execution.agentSessionId);
  return requests.some((request) => request.status === "spawning" || request.status === "running");
}

async function recover(authority: AuthorityState): Promise<void> {
  const { store, clock } = authority;
  for (const executionId of await store.executions()) {
    if (authority.stopped) return;
    if (!(await authorityIsInUse(authority, executionId)))
      await onExecutionTerminal(authority, executionId);
  }
  for (const lease of await store.leases()) {
    if (authority.stopped) return;
    if (!(await authorityIsInUse(authority, lease.executionId))) {
      await store.remove(lease.executionId);
      await release(authority, lease, true);
    } else if (lease.revoking || lease.deadlineAt <= clock.now()) {
      await release(authority, lease);
    } else {
      schedule(authority, lease);
    }
  }
}

async function onExecutionTerminal(authority: AuthorityState, executionId: string): Promise<void> {
  const { pending, store } = authority;
  const state = pending.get(executionId);
  if (state) state.terminal = true;
  await store.remove(executionId);
  await Promise.all(
    (await store.leases(executionId)).map((lease) => release(authority, lease, true)),
  );
}

function cancelTimer(authority: AuthorityState, id: string) {
  const { timers } = authority;
  timers.get(id)?.cancel();
  timers.delete(id);
}

function schedule(
  authority: AuthorityState,
  lease: ExecutionCredentialLease,
  databaseRetry = false,
) {
  const { timers, clock, options } = authority;
  cancelTimer(authority, lease.id);
  if (authority.stopped) return;
  let at = lease.revoking ? Math.min(lease.nextAttemptAt, lease.expiresAt) : lease.deadlineAt;
  if (databaseRetry) at = clock.now() + REVOCATION_RETRY_BASE_DELAY_MS;
  const cancel = clock.schedule(
    async () => {
      timers.delete(lease.id);
      try {
        await release(authority, lease);
      } catch (error) {
        reportFailure(
          error,
          {
            operation: "execution-authority.token.revoke",
            component: "execution-authority",
            executionId: lease.executionId,
          },
          options.logger ? { logger: options.logger } : {},
        );
        // A database outage must not discard the wakeup; durable state remains authoritative.
        schedule(authority, lease, true);
      }
    },
    Math.max(0, at - clock.now()),
  );
  timers.set(lease.id, { executionId: lease.executionId, cancel });
}

async function release(
  authority: AuthorityState,
  observed: ExecutionCredentialLease,
  requested = false,
): Promise<void> {
  const { options, store, clock } = authority;
  await options.database.withAdvisoryLock(`execution-credential:${observed.id}`, async () => {
    const lease = (await store.leases(observed.executionId)).find(
      (item) => item.id === observed.id,
    );
    if (!lease) {
      cancelTimer(authority, observed.id);
      return;
    }
    if (!requested && !lease.revoking && lease.deadlineAt > clock.now()) {
      schedule(authority, lease);
      return;
    }
    lease.revoking = true;
    // Persist intent before the external call; a replacement worker can finish it.
    await store.saveLease(lease);
    if (lease.expiresAt <= clock.now()) {
      await store.removeLease(lease.id);
      cancelTimer(authority, lease.id);
      return;
    }
    if (lease.nextAttemptAt > clock.now()) {
      schedule(authority, lease);
      return;
    }
    lease.attempts++;
    if (await revokeToken(authority, lease)) {
      await store.removeLease(lease.id);
      cancelTimer(authority, lease.id);
    } else {
      lease.nextAttemptAt = Math.min(
        lease.expiresAt,
        clock.now() + REVOCATION_RETRY_BASE_DELAY_MS * 2 ** Math.min(lease.attempts - 1, 10),
      );
      await store.saveLease(lease);
      schedule(authority, lease);
    }
  });
}

async function revokeToken(
  authority: AuthorityState,
  lease: ExecutionCredentialLease,
): Promise<boolean> {
  const { options } = authority;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        if (!options.githubAuthority)
          throw new Error("GitHub credential revocation is unavailable");
        return options.githubAuthority.revoke(lease.token);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("token revocation timed out")),
          TOKEN_REVOKE_WATCHDOG_MS,
        );
      }),
    ]);
    return true;
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "execution-authority.token.revoke",
        component: "execution-authority",
        executionId: lease.executionId,
      },
      {
        kind: "upstreamUnavailable",
        diagnostic: { attempt: lease.attempts },
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resourceCounts({ pending, timers }: AuthorityState): ExecutionAuthorityResourceCounts {
  return {
    executionStates: new Set([
      ...pending.keys(),
      ...[...timers.values()].map((timer) => timer.executionId),
    ]).size,
    leases: timers.size,
    pendingMaterializations: [...pending.values()].reduce((count, state) => count + state.count, 0),
  };
}

function repositoriesForAuthority(
  github: CompiledGitHubAuthority,
  triggerContext: unknown,
): readonly string[] {
  if (github.repositories !== undefined) return github.repositories;
  if (
    hasGitHubTarget(triggerContext) &&
    typeof triggerContext.target === "object" &&
    triggerContext.target !== null &&
    "repository" in triggerContext.target &&
    typeof triggerContext.target.repository === "string"
  ) {
    return [triggerContext.target.repository];
  }
  throw authorityError(
    "github_authority_scope_invalid",
    "github.repositories is required for this trigger source; Hub cannot safely expand authority to all installation repositories",
  );
}

function hasGitHubTarget(context: unknown): context is { target: unknown } {
  return (
    typeof context === "object" &&
    context !== null &&
    "provider" in context &&
    context.provider === "github" &&
    "target" in context
  );
}

function githubEnvironment(
  botUserId: number,
  botLogin: string,
  token: string,
): Record<string, string> {
  return {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: botLogin,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: `${botUserId}+${botLogin}@users.noreply.github.com`,
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
    GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    GIT_CONFIG_KEY_4: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_4: "!gh auth git-credential",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function terminalExecutionError(executionId: string): Error {
  return authorityError(
    "execution_terminal",
    `cannot materialize terminal execution ${executionId}`,
  );
}

function authorityStoppedError(): Error {
  return authorityError("execution_authority_stopped", "execution authority is stopped");
}

function unavailableCredentialsError(): Error {
  return authorityError(
    "execution_credentials_unavailable",
    "Execution credentials are no longer available",
  );
}

function authorityError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
