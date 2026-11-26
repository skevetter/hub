import type { CompiledEnvironment, CompiledTrigger } from "../../config/compiler.js";
import type { TriggerDocument } from "./schema.js";

export {
  parseTriggerDocument,
  TriggerDocumentError,
  type TriggerDocumentIssue,
} from "./document.js";
export { TriggerDocumentSchema, type TriggerDocument } from "./schema.js";
export {
  compileTriggerDocument,
  migrateLegacyBundle,
  serializeTriggerDocument,
  type MigratedLegacyTrigger,
  type SelfContainedLegacyTrigger,
} from "./legacy-migration.js";

export interface CompiledTriggerDocument {
  authored: TriggerDocument;
  environment: CompiledEnvironment;
  events: readonly CompiledTrigger[];
  authoredHash: string;
}
