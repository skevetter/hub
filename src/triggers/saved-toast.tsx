import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import type { ToastInput } from "../components/app/toast-store.js";

function ViewTriggerLink({
  organizationSlug,
  triggerId,
}: {
  organizationSlug: string;
  triggerId: string;
}) {
  const params = useMemo(() => ({ organizationSlug, triggerId }), [organizationSlug, triggerId]);
  return (
    <Link
      to="/o/$organizationSlug/triggers/$triggerId"
      params={params}
      className="text-link underline underline-offset-4 max-md:inline-flex max-md:min-h-11 max-md:items-center"
    >
      View trigger
    </Link>
  );
}

/**
 * The confirmation after the editor saves. The id carries the organization so a save in one
 * never replaces another organization's toast that is only hidden while it is not open.
 * A new trigger has no id yet, so only an edit can offer View.
 */
export function savedToast(organizationSlug: string, triggerId: string | undefined): ToastInput {
  const identity = {
    id: `trigger-saved:${organizationSlug}`,
    scope: organizationSlug,
    title: "Trigger saved",
  };
  if (triggerId === undefined) return identity;
  return {
    ...identity,
    action: <ViewTriggerLink organizationSlug={organizationSlug} triggerId={triggerId} />,
  };
}
