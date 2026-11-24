import { createFileRoute } from "@tanstack/react-router";
import { InstanceSettingsLayout } from "../../../../../auth/instance-settings.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/instance")({
  staticData: { breadcrumb: "Instance" },
  component: InstanceSettingsLayout,
});
