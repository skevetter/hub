import type { Database, TriggerRunRecord, WorkflowStepRunRecord } from "../db/types.js";
import type { TimelineRunScope } from "./capture-types.js";
import type { RunTimeline } from "./index.js";
import type { RunTimelineReconciler } from "./reconcile.js";

export const OBSERVED_DATABASE_METHODS = [
  "createWorkflowStepExecution",
  "linkWorkflowStepRunExecution",
  "startWorkflowScriptStep",
  "completeWorkflowStep",
  "completeWorkflowAgentExecution",
  "updateWorkflowScriptStep",
  "markWorkflowStepSkipped",
  "failWorkflowRun",
  "succeedTriggerRun",
  "recoverWorkflowDeadlines",
] as const satisfies readonly (keyof Database)[];

export interface ObservedDatabaseOptions {
  timeline: Pick<RunTimeline, "recordRunStart" | "recordStepStart">;
  reconciler: Pick<RunTimelineReconciler, "reconcile">;
  reportFailure?: (
    error: unknown,
    operation: string,
    scope?: TimelineRunScope,
  ) => void | Promise<void>;
}

export function createObservedDatabase(
  database: Database,
  options: ObservedDatabaseOptions,
): Database {
  async function report(
    error: unknown,
    operation: string,
    scope?: TimelineRunScope,
  ): Promise<void> {
    try {
      await options.reportFailure?.(error, operation, scope);
    } catch {
      return;
    }
  }

  function observe(operation: () => unknown, scope?: TimelineRunScope): void {
    try {
      void Promise.resolve(operation()).catch((error: unknown) =>
        report(error, "run.timeline.capture", scope),
      );
    } catch (error) {
      void report(error, "run.timeline.capture", scope);
    }
  }

  function after<T>(persisted: Promise<T>, observation: (result: T) => unknown): Promise<T> {
    void persisted.then(
      (result) => observe(() => observation(result)),
      () => undefined,
    );
    return persisted;
  }

  function scopeFor(run: TriggerRunRecord | undefined): TimelineRunScope | undefined {
    return run?.outcome === "accepted"
      ? { organizationId: run.organizationId, triggerRunId: run.id }
      : undefined;
  }

  function reconcile(scope: TimelineRunScope | undefined): void {
    if (scope !== undefined) {
      observe(() => options.reconciler.reconcile(scope.organizationId, scope.triggerRunId), scope);
    }
  }

  async function runScope(triggerRunId: string): Promise<TimelineRunScope | undefined> {
    return scopeFor(await database.findTriggerRunById(triggerRunId));
  }

  async function observeStep(
    step: WorkflowStepRunRecord | undefined,
    start = false,
  ): Promise<void> {
    if (step === undefined) return;
    const scope = await runScope(step.triggerRunId);
    if (scope === undefined) return;
    if (start && step.status === "running" && step.startedAt !== null) {
      observe(() => options.timeline.recordRunStart(scope), scope);
      observe(() => options.timeline.recordStepStart(scope, step.stepId), scope);
    }
    reconcile(scope);
  }

  async function observeExecution(executionId: string, run?: TriggerRunRecord): Promise<void> {
    if (run !== undefined) {
      reconcile(scopeFor(run));
      return;
    }
    const association = await database.resolveRunForExecution(executionId);
    if (association !== undefined) reconcile(await runScope(association.triggerRunId));
  }

  const overrides: Pick<Database, (typeof OBSERVED_DATABASE_METHODS)[number]> = {
    createWorkflowStepExecution: (input) =>
      after(database.createWorkflowStepExecution(input), (result) =>
        observeStep(result.stepRun, result.created),
      ),
    linkWorkflowStepRunExecution: (...args) =>
      after(database.linkWorkflowStepRunExecution(...args), (step) => observeStep(step, true)),
    startWorkflowScriptStep: (input) =>
      after(database.startWorkflowScriptStep(input), (result) =>
        observeStep(result?.stepRun, result?.started === true),
      ),
    completeWorkflowStep: (...args) =>
      after(database.completeWorkflowStep(...args), (result) =>
        result === undefined ? observeExecution(args[0]) : reconcile(scopeFor(result.run)),
      ),
    completeWorkflowAgentExecution: (input) =>
      after(database.completeWorkflowAgentExecution(input), (result) =>
        observeExecution(result.execution.id, result.terminalRun),
      ),
    updateWorkflowScriptStep: (...args) =>
      after(database.updateWorkflowScriptStep(...args), (step) => observeStep(step)),
    markWorkflowStepSkipped: (...args) =>
      after(database.markWorkflowStepSkipped(...args), (result) =>
        reconcile(scopeFor(result?.run)),
      ),
    failWorkflowRun: (...args) =>
      after(database.failWorkflowRun(...args), (result) => reconcile(scopeFor(result?.run))),
    succeedTriggerRun: (id) =>
      after(database.succeedTriggerRun(id), (result) => reconcile(scopeFor(result?.run))),
    recoverWorkflowDeadlines: (now) =>
      after(database.recoverWorkflowDeadlines(now), (recoveries) => {
        for (const recovery of recoveries) {
          observe(async () => reconcile(await runScope(recovery.triggerRunId)));
        }
      }),
  };
  const bindings = new Map<PropertyKey, unknown>();
  return new Proxy(database, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        const override: unknown = Reflect.get(overrides, property);
        return override;
      }
      if (bindings.has(property)) return bindings.get(property);
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const bound = (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      bindings.set(property, bound);
      return bound;
    },
  });
}
