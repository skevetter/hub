import type { ListProvider } from "../triggers/list-providers.js";

// Manual triggers also serve webhook calls. Active definitions exist even while disabled.
export function triggerProviderEvent(provider: ListProvider): string {
  if (provider === "manual" || provider === "webhook") return "manual.run";
  if (provider === "github_notification") return "github.notification";
  return `${provider}.`;
}

export function hasTriggerEvent(
  configuration: unknown,
  match: (event: string) => boolean,
): boolean {
  if (
    configuration === null ||
    typeof configuration !== "object" ||
    !("triggers" in configuration) ||
    !Array.isArray(configuration.triggers)
  )
    return false;
  return configuration.triggers.some(
    (trigger: unknown) =>
      trigger !== null &&
      typeof trigger === "object" &&
      "on" in trigger &&
      typeof trigger.on === "string" &&
      match(trigger.on),
  );
}
