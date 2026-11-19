import { parseConnectionTemplate } from "../config/connection-template.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

export function temporaryCredentialFact(intent: LaunchMachineIntent | null): boolean | null {
  if (intent === null) return null;
  if (intent.github !== undefined) return true;
  if (intent.environment == null) return null;
  try {
    const values = Object.values({ ...intent.environment.env, ...intent.env });
    return values.some((value) => parseConnectionTemplate(value).length > 0);
  } catch {
    return null;
  }
}
