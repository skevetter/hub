/**
 * Which executions have a finish_execution call in flight or already completed.
 *
 * The MCP handler knows the owning execution before the tool runs, so ownership is recorded there
 * and nowhere else. A daemon event stream is shared by every execution on a continued session and
 * names no execution, so it cannot say whose finish call it shows. Memory only: it lives in the
 * process that serves the MCP tool and runs the lifecycle, and an entry is freed when its
 * execution leaves the live state.
 */
export class FinishCallRegistry {
  private readonly entries = new Map<string, { unresolved: number; completed: boolean }>();

  /** A finish call began. Call before the tool does any work. */
  start(executionId: string): void {
    const entry = this.entries.get(executionId) ?? { unresolved: 0, completed: false };
    entry.unresolved += 1;
    this.entries.set(executionId, entry);
  }

  /**
   * One call ended. A no-op for an execution that was already released, so a call that outlives
   * its execution does not leave an entry behind.
   */
  resolve(executionId: string, outcome: "completed" | "failed"): void {
    const entry = this.entries.get(executionId);
    if (entry === undefined) return;
    entry.unresolved = Math.max(0, entry.unresolved - 1);
    if (outcome === "completed") entry.completed = true;
  }

  /**
   * Whether the explicit finish owns the outcome: a call is unresolved, or one completed. A call
   * that failed with nothing else running leaves the execution unfinished.
   */
  ownsOutcome(executionId: string): boolean {
    const entry = this.entries.get(executionId);
    return entry !== undefined && (entry.unresolved > 0 || entry.completed);
  }

  /** The execution left the live state. */
  release(executionId: string): void {
    this.entries.delete(executionId);
  }

  get size(): number {
    return this.entries.size;
  }
}
