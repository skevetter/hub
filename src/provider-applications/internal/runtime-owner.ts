import type { RunProgressSettings } from "../../run-progress/settings.js";
import type { AuthServer } from "../../auth/server.js";
import { createHash } from "node:crypto";
import type { Database } from "../../db/types.js";
import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import { logger } from "../../logger.js";
import { reportFailure } from "../../failures/index.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import {
  createLinearRegistration,
  type LinearPilotRegistration,
} from "../../providers/linear/index.js";
import type {
  ProviderRegistration,
  TriggerProviderResources,
} from "../../providers/registration.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "../../triggers/index.js";
import type {
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderRuntimeCandidate,
  ProviderRuntimeOwner,
} from "../index.js";
import { parseProviderApplicationConfiguration } from "./store.js";
import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../../triggers/github/classification.js";
import { runShutdownStage } from "../../shutdown-stage.js";

interface Slot {
  active: ActiveRegistration | undefined;
  identity: ProviderApplicationIdentity | undefined;
  triggerResources: TriggerProviderResources | undefined;
  handler: TriggerHandler | undefined;
}

interface ActiveRegistration {
  provider: Provider;
  registration: ProviderRegistration;
  triggers: readonly TriggerProvider[];
  sourcesStarted: boolean;
  acceptingEvents: boolean;
  leases: number;
  retiring: boolean;
  retirement: Promise<void> | undefined;
}

class ProviderRuntimeUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll("_", " "));
    this.name = "ProviderRuntimeUnavailableError";
  }
}

function unavailable(code: string): ProviderRuntimeUnavailableError {
  return new ProviderRuntimeUnavailableError(code);
}

type SlackInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>
>[0];
type LinearInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>
>[0];

interface RegistrationActivation {
  expectedConfigurationVersion: number | undefined;
  activateConfiguration: boolean;
}

function registrationActivationOptions(activation?: RegistrationActivation) {
  const expectedConfigurationVersion = activation?.expectedConfigurationVersion;
  return {
    ...(expectedConfigurationVersion === undefined ? {} : { expectedConfigurationVersion }),
    activateConfiguration: activation?.activateConfiguration ?? false,
  };
}

interface DynamicProviderRuntimeOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  runProgress?: RunProgressSettings;
  linearPilot?: LinearPilotRegistration;
  registrationFactory?: (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: SlackInstallationHandler;
    onVerifiedLinearInstallation: LinearInstallationHandler;
  }) => ProviderRegistration;
}

type PrepareArguments = Parameters<ProviderRuntimeOwner["prepare"]>;

interface BuildRegistrationInput {
  provider: Provider;
  configuration: ProviderApplicationConfiguration;
  callbackOrigin: string;
  configurationVersion: number;
  activation: RegistrationActivation | undefined;
}

type SharedRegistrationOptions = ReturnType<DynamicProviderRuntime["registrationOptions"]>;
type TriggerInvocation = <T>(operation: (trigger: TriggerProvider) => Promise<T>) => Promise<T>;
type ConnectionAttemptSnapshot = NonNullable<
  Awaited<ReturnType<Database["findConnectionAttemptConfiguration"]>>
>;

/** @package */
export class DynamicProviderRuntime implements ProviderRuntimeOwner {
  private readonly slots = new Map<Provider, Slot>([
    ["github", emptySlot()],
    ["slack", emptySlot()],
    ["discord", emptySlot()],
    ["linear", emptySlot()],
  ]);
  private readonly stable: Record<Provider, ProviderRegistration>;
  private slackInstallationHandler: SlackInstallationHandler | undefined;
  private linearInstallationHandler: LinearInstallationHandler | undefined;

  constructor(private readonly options: DynamicProviderRuntimeOptions) {
    this.stable = {
      github: this.stableRegistration("github"),
      slack: this.stableRegistration("slack"),
      discord: this.stableRegistration("discord"),
      linear: this.stableRegistration("linear"),
    };
  }

  static {
    Object.defineProperty(Reflect.get(this.prototype, "prepare"), "length", { value: 6 });
  }

  registrations(): readonly ProviderRegistration[] {
    return [this.stable.github, this.stable.discord, this.stable.slack, this.stable.linear];
  }

  identity(provider: Provider): ProviderApplicationIdentity | undefined {
    return this.slot(provider).identity;
  }

  slackDelivery(): { status(): SlackDeliveryStatus; retry(): Promise<void> } | undefined {
    return this.slot("slack").active?.registration.slackDelivery;
  }

  onSlackInstallation(
    handler: NonNullable<DynamicProviderRuntime["slackInstallationHandler"]>,
  ): void {
    this.slackInstallationHandler = handler;
  }

  onLinearInstallation(
    handler: NonNullable<DynamicProviderRuntime["linearInstallationHandler"]>,
  ): void {
    this.linearInstallationHandler = handler;
  }

  async prepare(
    ...[
      provider,
      configuration,
      callbackOrigin,
      identity,
      configurationVersion,
      activation,
    ]: PrepareArguments
  ): Promise<ProviderRuntimeCandidate> {
    const registration = this.build({
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      activation,
    });
    const slot = this.slot(provider);
    const triggerResources = slot.triggerResources;
    const active = createActiveRegistration(provider, registration, triggerResources);
    let published = false;
    return {
      start: async () => {
        if (slot.handler === undefined) return;
        await startSources(active, slot.handler);
      },
      beginConnection: (request) => beginCandidateConnection(registration, request),
      publish: () => {
        const previous = slot.active;
        if (previous !== undefined) previous.acceptingEvents = false;
        slot.active = active;
        slot.identity = identity;
        active.acceptingEvents = true;
        published = true;
        if (previous !== undefined) this.retirePrevious(provider, previous);
      },
      close: () => (published ? Promise.resolve() : stopSources(active)),
    };
  }

  private retirePrevious(provider: Provider, previous: ActiveRegistration): void {
    previous.retiring = true;
    void stopSources(previous).catch((error: unknown) => {
      reportFailure(error, {
        operation: "provider_runtime.retire_inbound",
        component: "provider_runtime",
        provider,
      });
    });
    void this.retireWhenDrained(provider, previous);
  }

  private build(input: BuildRegistrationInput): ProviderRegistration {
    if (this.options.registrationFactory !== undefined) {
      return this.options.registrationFactory(this.customRegistrationInput(input));
    }
    return this.buildNative(input);
  }

  private registrationOptions(callbackOrigin: string, configurationVersion: number) {
    return {
      database: this.options.database,
      auth: this.options.auth,
      applicationBaseUrl: this.options.applicationBaseUrl,
      publicBaseUrl: callbackOrigin,
      configurationVersion,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    };
  }

  private buildNative({
    provider,
    configuration,
    callbackOrigin,
    configurationVersion,
    activation,
  }: BuildRegistrationInput): ProviderRegistration {
    const shared = this.registrationOptions(callbackOrigin, configurationVersion);
    if (provider === "github" && configuration.provider === "github") {
      return this.githubRegistration(shared, configuration);
    }
    if (provider === "slack" && configuration.provider === "slack") {
      return createSlackRegistration({
        ...shared,
        configuration,
        ...registrationActivationOptions(activation),
        onVerifiedInstallation: (input) => this.handleSlackInstallation(input),
      });
    }
    if (provider === "discord" && configuration.provider === "discord") {
      return createDiscordRegistration({
        ...shared,
        configuration: {
          clientId: configuration.applicationId,
          clientSecret: configuration.clientSecret,
          botToken: configuration.botToken,
        },
      });
    }
    if (provider === "linear" && configuration.provider === "linear") {
      return this.linearRegistration(shared, configuration, activation);
    }
    throw new Error("provider configuration mismatch");
  }

  private githubRegistration(
    shared: SharedRegistrationOptions,
    configuration: Extract<ProviderApplicationConfiguration, { provider: "github" }>,
  ): ProviderRegistration {
    return createGitHubRegistration({
      ...shared,
      configuration,
      ...(this.options.runProgress === undefined ? {} : { runProgress: this.options.runProgress }),
    });
  }

  private linearRegistration(
    shared: SharedRegistrationOptions,
    configuration: Extract<ProviderApplicationConfiguration, { provider: "linear" }>,
    activation: RegistrationActivation | undefined,
  ): ProviderRegistration {
    return createLinearRegistration({
      ...shared,
      configuration,
      ...(this.options.linearPilot === undefined ? {} : { linearPilot: this.options.linearPilot }),
      ...registrationActivationOptions(activation),
      onVerifiedInstallation: (input) => this.handleLinearInstallation(input),
    });
  }

  private customRegistrationInput({
    provider,
    configuration,
    callbackOrigin,
    configurationVersion,
    activation,
  }: BuildRegistrationInput): Parameters<
    NonNullable<DynamicProviderRuntimeOptions["registrationFactory"]>
  >[0] {
    return {
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      expectedConfigurationVersion: activation?.expectedConfigurationVersion,
      activateConfiguration: activation?.activateConfiguration ?? false,
      onVerifiedSlackInstallation: (input) => this.handleSlackInstallation(input),
      onVerifiedLinearInstallation: (input) => this.handleLinearInstallation(input),
    };
  }

  private handleSlackInstallation(input: Parameters<SlackInstallationHandler>[0]): Promise<void> {
    if (this.slackInstallationHandler === undefined) {
      throw unavailable("slack_installation_handler_unavailable");
    }
    return this.slackInstallationHandler(input);
  }

  private handleLinearInstallation(input: Parameters<LinearInstallationHandler>[0]): Promise<void> {
    if (this.linearInstallationHandler === undefined) {
      throw unavailable("linear_installation_handler_unavailable");
    }
    return this.linearInstallationHandler(input);
  }

  private stableRegistration(provider: Provider): ProviderRegistration {
    const slot = this.slot(provider);
    const source = this.stableSource(slot);
    const connectionActions = this.stableConnectionActions(provider, slot);
    return {
      connection: {
        name: provider,
        status: (connections) =>
          slot.active?.registration.connection.status(connections) ?? {
            status: "notConfigured" as const,
          },
        actions: connectionActions,
      },
      ...(provider === "github" ? { integration: this.stableGitHubIntegration(slot) } : {}),
      get progressProvider() {
        return slot.active?.registration.progressProvider;
      },
      get linearRunReplyWriter() {
        return slot.active?.registration.linearRunReplyWriter;
      },
      triggerProviders: [(resources) => this.setTriggerResources(provider, slot, resources)],
      sources: [source],
      outputs: [this.stableOutput(provider, slot)],
      requests: this.stableRequests(provider, slot),
      ...(provider === "slack" || provider === "discord"
        ? { attachment: this.stableAttachment(provider, slot) }
        : {}),
    };
  }

  private stableSource(slot: Slot): TriggerSource {
    return {
      start: async (handler) => {
        slot.handler = handler;
        if (slot.active !== undefined) await startSources(slot.active, handler);
      },
      stop: async () => {
        slot.handler = undefined;
        if (slot.active !== undefined) {
          slot.active.acceptingEvents = false;
          await stopSources(slot.active);
        }
      },
    };
  }

  private stableConnectionActions(
    provider: Provider,
    slot: Slot,
  ): ProviderRegistration["connection"]["actions"] {
    return Object.fromEntries(
      actionNames(provider).map((action) => [
        action,
        async (request: Request) => {
          const active = await this.registrationForAction(provider, slot, action, request);
          if (active === undefined) {
            return Response.json({ error: "provider_not_configured" }, { status: 409 });
          }
          return this.withLease(
            active,
            () =>
              active.registration.connection.actions[action]?.(request) ??
              Promise.resolve(Response.json({ error: "provider_not_configured" }, { status: 409 })),
          );
        },
      ]),
    );
  }

  private stableGitHubIntegration(slot: Slot): NonNullable<ProviderRegistration["integration"]> {
    return {
      resolve: (
        ...args: Parameters<NonNullable<ProviderRegistration["integration"]>["resolve"]>
      ) => {
        const active = slot.active;
        const integration = active?.registration.integration;
        if (active === undefined || integration === undefined) {
          throw unavailable("github_integration_unavailable");
        }
        return this.withLease(active, () => integration.resolve(...args));
      },
      githubAuthority: {
        mint: (
          input: Parameters<
            NonNullable<NonNullable<ProviderRegistration["integration"]>["githubAuthority"]>["mint"]
          >[0],
        ) => {
          const active = slot.active;
          const authority = active?.registration.integration?.githubAuthority;
          if (active === undefined || authority === undefined) {
            throw unavailable("github_authority_unavailable");
          }
          return this.withLease(active, () => authority.mint(input));
        },
        revoke: (token: string) => {
          const active = slot.active;
          const authority = active?.registration.integration?.githubAuthority;
          if (active === undefined || authority === undefined) {
            throw unavailable("github_authority_unavailable");
          }
          return this.withLease(active, () => authority.revoke(token));
        },
      },
    };
  }

  private setTriggerResources(
    provider: Provider,
    slot: Slot,
    resources: TriggerProviderResources,
  ): TriggerProvider {
    slot.triggerResources = resources;
    if (slot.active !== undefined) {
      slot.active.triggers = slot.active.registration.triggerProviders
        .map((factory) => factory(resources))
        .filter((trigger): trigger is TriggerProvider => trigger !== undefined);
    }
    return this.dynamicTrigger(provider, slot);
  }

  private stableOutput(provider: Provider, slot: Slot): ProviderRegistration["outputs"][number] {
    return {
      type: `${provider}.reply`,
      tool: replyOutputTool,
      available: (context) => {
        const output = slot.active?.registration.outputs.find(
          (candidate) => candidate.type === `${provider}.reply`,
        );
        return output !== undefined && (output.available?.(context) ?? true);
      },
      execute: (input) => {
        const active = slot.active;
        const output = active?.registration.outputs.find(
          (candidate) => candidate.type === `${provider}.reply`,
        );
        if (active === undefined || output === undefined) {
          throw unavailable(`${provider}_output_unavailable`);
        }
        return this.withLease(active, () => output.execute(input));
      },
    };
  }

  private stableRequests(provider: Provider, slot: Slot): ProviderRegistration["requests"] {
    return provider === "discord"
      ? []
      : [
          {
            name: provider === "github" ? "webhook" : `${provider}.events`,
            handle: (request) => {
              const active = slot.active;
              const handler = active?.registration.requests[0];
              return active === undefined || handler === undefined
                ? Promise.resolve(new Response("Not Found", { status: 404 }))
                : this.withLease(active, () => handler.handle(request));
            },
          },
        ];
  }

  private stableAttachment(
    provider: "discord" | "slack",
    slot: Slot,
  ): NonNullable<ProviderRegistration["attachment"]> {
    return {
      provider,
      resolve: (input) => {
        const active = slot.active;
        const attachment = active?.registration.attachment;
        if (active === undefined || attachment === undefined) {
          throw unavailable(`${provider}_attachment_unavailable`);
        }
        return this.withLease(active, () => attachment.resolve(input));
      },
    };
  }

  private slot(provider: Provider): Slot {
    const slot = this.slots.get(provider);
    if (slot === undefined) throw new Error(`unknown provider: ${provider}`);
    return slot;
  }

  private dynamicTrigger(provider: Provider, slot: Slot): TriggerProvider {
    const current = () => {
      const active = slot.active;
      const trigger = active?.triggers[0];
      if (active === undefined || trigger === undefined) {
        throw unavailable(`${provider}_trigger_unavailable`);
      }
      return { active, trigger };
    };
    const invoke = <T>(operation: (trigger: TriggerProvider) => Promise<T>) => {
      const selected = current();
      return this.withLease(selected.active, () => operation(selected.trigger));
    };
    return {
      name: provider,
      eventNames: eventNames(provider),
      match: async (external) => {
        const selected = current();
        return this.withLease(selected.active, () => selected.trigger.match(external));
      },
      materializeLaunch: (input) =>
        invoke((trigger) => trigger.materializeLaunch?.(input) ?? Promise.resolve({})),
      materializeContext: (input) =>
        invoke((trigger) => trigger.materializeContext?.(input) ?? Promise.resolve(undefined)),
      ...dynamicTriggerHooks(invoke),
    };
  }

  private async withLease<T>(active: ActiveRegistration, operation: () => Promise<T>): Promise<T> {
    active.leases += 1;
    try {
      return await operation();
    } finally {
      active.leases -= 1;
      if (active.retiring) {
        void this.retireWhenDrained(active.provider, active);
      }
    }
  }

  private retireWhenDrained(provider: Provider, active: ActiveRegistration): Promise<void> {
    if (active.leases > 0) return Promise.resolve();
    active.retirement ??= retire(provider, active);
    return active.retirement;
  }

  private async registrationForAction(
    provider: Provider,
    slot: Slot,
    action: string,
    request: Request,
  ): Promise<ActiveRegistration | undefined> {
    if (action !== "callback" && action !== "setup") return slot.active;
    const state = new URL(request.url).searchParams.get("state");
    if (state === null) return slot.active;
    const snapshot = await this.options.database.findConnectionAttemptConfiguration(
      createHash("sha256").update(state).digest("hex"),
    );
    if (snapshot === undefined) return slot.active;
    return this.registrationForSnapshot(provider, slot, snapshot);
  }

  private registrationForSnapshot(
    provider: Provider,
    slot: Slot,
    snapshot: ConnectionAttemptSnapshot,
  ): ActiveRegistration | undefined {
    const existing =
      slot.active?.registration.configurationSnapshot?.version === snapshot.configurationVersion &&
      slot.active.registration.configurationSnapshot.callbackOrigin === snapshot.callbackOrigin
        ? slot.active
        : undefined;
    if (existing !== undefined) return existing;
    try {
      const configuration = parseProviderApplicationConfiguration(snapshot.configurationSnapshot);
      if (configuration.provider !== provider) return slot.active;
      const registration = this.build({
        provider,
        configuration,
        callbackOrigin: snapshot.callbackOrigin,
        configurationVersion: snapshot.configurationVersion,
        activation: {
          expectedConfigurationVersion: snapshot.expectedConfigurationVersion ?? undefined,
          activateConfiguration: snapshot.activateConfiguration,
        },
      });
      return createActiveRegistration(provider, registration, undefined);
    } catch (error) {
      reportFailure(error, {
        operation: "provider_runtime.restore_callback_snapshot",
        component: "provider_runtime",
        provider,
      });
      return slot.active;
    }
  }
}

function createActiveRegistration(
  provider: Provider,
  registration: ProviderRegistration,
  triggerResources: TriggerProviderResources | undefined,
): ActiveRegistration {
  return {
    provider,
    registration,
    triggers:
      triggerResources === undefined
        ? []
        : registration.triggerProviders
            .map((factory) => factory(triggerResources))
            .filter((trigger): trigger is TriggerProvider => trigger !== undefined),
    sourcesStarted: false,
    acceptingEvents: false,
    leases: 0,
    retiring: false,
    retirement: undefined,
  };
}

async function beginCandidateConnection(
  registration: ProviderRegistration,
  request: Request,
): Promise<{ url: string }> {
  const response = await registration.connection.actions["start"]?.(request);
  if (response === undefined || !response.ok) throw unavailable("provider_application_unavailable");
  const body: unknown = await response.json();
  const url =
    body !== null && typeof body === "object" && "url" in body
      ? Reflect.get(body, "url")
      : undefined;
  if (typeof url !== "string") throw unavailable("provider_application_unavailable");
  return { url };
}

function dynamicTriggerHooks(
  invoke: TriggerInvocation,
): Pick<
  TriggerProvider,
  | "onDispatchAccepted"
  | "onAgentExecutionStarted"
  | "onAgentExecutionCompleted"
  | "onAgentExecutionFailed"
  | "onAgentExecutionTerminal"
  | "onMachineTerminated"
> {
  return {
    onDispatchAccepted: (triggerContext, outputContext, reactionState) =>
      invoke(
        (trigger) =>
          trigger.onDispatchAccepted?.(triggerContext, outputContext, reactionState) ??
          Promise.resolve(),
      ),
    onAgentExecutionStarted: (triggerContext, outputContext, reactionState) =>
      invoke(
        (trigger) =>
          trigger.onAgentExecutionStarted?.(triggerContext, outputContext, reactionState) ??
          Promise.resolve(),
      ),
    onAgentExecutionCompleted: (triggerContext, outputContext, result, reactionState) =>
      invoke(
        (trigger) =>
          trigger.onAgentExecutionCompleted?.(
            triggerContext,
            outputContext,
            result,
            reactionState,
          ) ?? Promise.resolve(),
      ),
    onAgentExecutionFailed: (triggerContext, outputContext, reason, reactionState) =>
      invoke(
        (trigger) =>
          trigger.onAgentExecutionFailed?.(triggerContext, outputContext, reason, reactionState) ??
          Promise.resolve(),
      ),
    onAgentExecutionTerminal: (executionId, triggerContext) =>
      invoke(
        (trigger) =>
          trigger.onAgentExecutionTerminal?.(executionId, triggerContext) ?? Promise.resolve(),
      ),
    onMachineTerminated: (triggerContext, reason, reactionState) =>
      invoke(
        (trigger) =>
          trigger.onMachineTerminated?.(triggerContext, reason, reactionState) ?? Promise.resolve(),
      ),
  };
}

function emptySlot(): Slot {
  return {
    active: undefined,
    identity: undefined,
    triggerResources: undefined,
    handler: undefined,
  };
}

function actionNames(provider: Provider): readonly string[] {
  if (provider === "github") return ["start", "disconnect", "setup", "callback"];
  return ["start", "disconnect", "callback"];
}

function eventNames(provider: Provider): TriggerProvider["eventNames"] {
  if (provider === "slack") return ["slack.mention"];
  if (provider === "discord") return ["discord.mention"];
  if (provider === "linear") return ["linear.issue", "linear.comment"];
  return GITHUB_TRIGGER_SOURCE_NAMES;
}

async function startSources(active: ActiveRegistration, handler: TriggerHandler): Promise<void> {
  if (active.sourcesStarted) return;
  const started: TriggerSource[] = [];
  try {
    for (const source of active.registration.sources) {
      await source.start((trigger) =>
        active.acceptingEvents
          ? handler(trigger)
          : Promise.reject(new Error("provider source was retired")),
      );
      started.push(source);
    }
    active.sourcesStarted = true;
  } catch (error) {
    const cleanup = await Promise.allSettled(
      started
        .toReversed()
        .map((source, index) =>
          runShutdownStage(`provider.${active.provider}.cleanup-source.${index}`, () =>
            source.stop(),
          ),
        ),
    );
    for (const failure of cleanup) {
      if (failure.status === "rejected") {
        reportFailure(failure.reason, {
          operation: "provider_runtime.start_sources.cleanup",
          component: "provider_runtime",
          provider: active.provider,
        });
      }
    }
    throw error;
  }
}

async function stopSources(active: ActiveRegistration): Promise<void> {
  if (!active.sourcesStarted) return;
  active.sourcesStarted = false;
  const results = await Promise.allSettled(
    active.registration.sources
      .toReversed()
      .map((source, index) =>
        runShutdownStage(`provider.${active.provider}.source.${index}`, () => source.stop()),
      ),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

async function retire(provider: Provider, active: ActiveRegistration): Promise<void> {
  try {
    await stopSources(active);
  } catch (error) {
    reportFailure(
      error,
      { operation: "provider_runtime.retire", component: "provider_runtime", provider },
      { logger, kind: "internal" },
    );
  }
}
