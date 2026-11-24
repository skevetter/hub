import { useCallback } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { PageHeader } from "./page.js";
import { Button } from "../ui/button.js";

interface RouteStateProps {
  title: string;
  description: string;
  home: string;
  retry?: () => void;
}

export function RouteState({ title, description, home, retry }: RouteStateProps) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <div className="flex flex-wrap gap-2">
        {retry === undefined ? null : <Button onClick={retry}>Retry</Button>}
        <Button asChild variant={retry === undefined ? "default" : "outline"}>
          <a href={home}>Go home</a>
        </Button>
      </div>
    </div>
  );
}

export function NotFoundPage({ home = "/" }: { home?: string }) {
  return (
    <RouteState
      title="Page not found"
      description="This address does not match a page in Paseo Hub."
      home={home}
    />
  );
}

const SAFE_MESSAGES = new Set(["Organization unavailable."]);

export function routeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (SAFE_MESSAGES.has(message)) return message;
  const reference =
    /quote reference ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) when reporting it\./iu.exec(
      message,
    )?.[1];
  return reference === undefined
    ? "The page could not be loaded."
    : `The page could not be loaded. If it happens again, quote reference ${reference} when reporting it.`;
}

export function ErrorPage({
  error,
  home,
  retry,
}: {
  error: unknown;
  home: string;
  retry: () => void;
}) {
  return (
    <RouteState
      title="Page unavailable"
      description={routeErrorMessage(error)}
      home={home}
      retry={retry}
    />
  );
}

export function homeFor(organizationSlug: string | undefined): string {
  return organizationSlug === undefined ? "/" : `/o/${encodeURIComponent(organizationSlug)}/home`;
}

export function useRouteHome(): string {
  const params: { organizationSlug?: string } = useParams({ strict: false });
  return homeFor(params.organizationSlug);
}

export function RouteNotFound() {
  return <NotFoundPage home={useRouteHome()} />;
}

// Server-rendered loader errors arrive without a reset function.
export function RouteErrorBoundary({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter();
  const home = useRouteHome();
  const retry = useCallback(() => void router.invalidate().then(() => reset?.()), [router, reset]);
  return <ErrorPage error={error} home={home} retry={retry} />;
}
