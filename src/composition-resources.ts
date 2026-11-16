import { runShutdownStage } from "./shutdown-stage.js";

export type CloseResource = () => Promise<void>;

/** Owns composed runtime resources and closes every one in reverse acquisition order. */
export class CompositionResources {
  private resources: { close: CloseResource; stage: string }[] = [];
  private closing: Promise<void> | undefined;

  own(close: CloseResource, stage = `composition.resource.${this.resources.length}`): void {
    if (this.closing !== undefined) throw new Error("composition resources are already closing");
    this.resources.push({ close, stage });
  }

  close(): Promise<void> {
    this.closing ??= this.closeOwnedResources();
    return this.closing;
  }

  private async closeOwnedResources(): Promise<void> {
    const errors: unknown[] = [];
    for (const { close, stage } of this.resources.toReversed()) {
      try {
        await runShutdownStage(stage, close);
      } catch (error) {
        errors.push(error);
      }
    }
    this.resources = [];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "multiple composition resources failed to close");
  }
}
