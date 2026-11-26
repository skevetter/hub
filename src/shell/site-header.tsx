import { CrumbLink } from "./crumb-link.js";
import { usePageContext, type Crumb } from "../navigation/index.js";
import { cn } from "../lib/utils.js";
import { Separator } from "../components/ui/separator.js";
import { SidebarTrigger } from "../components/ui/sidebar.js";
import { SiteHeaderActionsTarget } from "./site-header-actions.js";

const CRUMB_LINK =
  "truncate underline-offset-4 hover:text-foreground hover:underline focus-visible:underline";

/**
 * Header context, not a second title. The page owns its `<h1>`; this says where that page sits,
 * which is why it leads with where you are (the same scope the sidebar header stacks) rather
 * than repeating the view. Every crumb but the current page is a link up the chain.
 */
export function SiteHeader({
  scope,
  organizationSlug,
  project,
}: {
  scope: string;
  organizationSlug: string;
  project?: string;
}) {
  const { breadcrumbs: trail } = usePageContext();
  return (
    <header className="sticky top-0 z-10 hidden shrink-0 items-center gap-2 bg-background px-4 max-md:static sm:flex md:h-12 md:border-b">
      <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
      <Separator orientation="vertical" className="mr-1 hidden h-4 md:block" />
      <nav
        aria-label="Breadcrumb"
        className="hidden min-w-0 items-center gap-1.5 overflow-hidden text-sm md:flex"
      >
        <CrumbLink
          to={`/o/${organizationSlug}/home`}
          className={cn(CRUMB_LINK, "text-muted-foreground")}
        >
          {scope}
        </CrumbLink>
        {project === undefined ? null : <Crumb context>{project}</Crumb>}
        {trail.map((entry, index) => (
          <TrailCrumb
            key={`${entry.to}:${entry.label}`}
            entry={entry}
            current={index === trail.length - 1}
          />
        ))}
      </nav>
      <SiteHeaderActionsTarget />
    </header>
  );
}

function TrailCrumb({ entry, current }: { entry: Crumb; current: boolean }) {
  if (current) return <Crumb current>{entry.label}</Crumb>;
  return (
    <Crumb context>
      <CrumbLink to={entry.to} className={CRUMB_LINK}>
        {entry.label}
      </CrumbLink>
    </Crumb>
  );
}

function Crumb({
  context = false,
  current = false,
  children,
}: {
  context?: boolean;
  current?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", context && "text-muted-foreground")}>
      <span aria-hidden="true" className="text-muted-foreground">
        /
      </span>
      {current ? (
        <span aria-current="page" className="truncate">
          {children}
        </span>
      ) : (
        children
      )}
    </span>
  );
}
