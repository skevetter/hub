import { load } from "js-yaml";

import { TriggerDocumentSchema, type TriggerDocument } from "./schema.js";

export interface TriggerDocumentIssue {
  path: readonly (string | number)[];
  message: string;
}

export class TriggerDocumentError extends Error {
  constructor(readonly issues: readonly TriggerDocumentIssue[]) {
    super(issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    this.name = "TriggerDocumentError";
  }
}

export function parseTriggerDocument(yaml: string): TriggerDocument {
  let input: unknown;
  try {
    input = load(yaml);
  } catch (error) {
    throw new TriggerDocumentError([
      { path: [], message: error instanceof Error ? error.message : "invalid YAML" },
    ]);
  }
  const parsed = TriggerDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new TriggerDocumentError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? (segment.description ?? String(segment)) : segment,
        ),
        message:
          issue.code === "unrecognized_keys"
            ? `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}`
            : issue.message,
      })),
    );
  }
  return parsed.data;
}
