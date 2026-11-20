import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { TriggerActivityPanel } from "../../../../../triggers/activity-panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity/")({
  // `page` only labels the range on screen; the cursor is what positions the list.
  validateSearch: z.object({
    cursor: z.string().max(512).optional().catch(undefined),
    page: z.number().int().min(1).optional().catch(undefined),
  }),
  component: TriggerActivityPanel,
});
