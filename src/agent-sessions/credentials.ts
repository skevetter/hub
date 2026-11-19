import { parseConnectionTemplate } from "../config/connection-template.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

export function temporaryCredentialFact(intent: LaunchMachineIntent | null): boolean | null {
  if (intent === null) return null;
  try {
    return hasTemporaryCredentials(intent);
  } catch {
    return null;
  }
}

export function hasTemporaryCredentials(intent: LaunchMachineIntent): boolean {
  return (
    intent.github !== undefined ||
    Object.values({ ...intent.environment.env, ...intent.env }).some(
      (value) => parseConnectionTemplate(value).length > 0,
    )
  );
}
