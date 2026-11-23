import { usePageContext } from "../navigation/index.js";
import { cn } from "../lib/utils.js";
import { Separator } from "../components/ui/separator.js";
import { SidebarTrigger } from "../components/ui/sidebar.js";
import { SiteHeaderActionsTarget } from "./site-header-actions.js";

/**
 * Header context, not a second title. The page owns its `<h1>`; this says where that page sits,
 * which is why it leads with where you are — the same scope the sidebar header stacks — rather
 * than repeating the view.
 */
export function SiteHeader({ scope, project }: { scope: string; project?: string }) {
  const { breadcrumbs: trail } = usePageContext();
  return (
    <header className="sticky top-0 z-10 hidden shrink-0 items-center gap-2 bg-background px-4 max-md:static sm:flex md:h-12 md:border-b">
      <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
      <Separator orientation="vertical" className="mr-1 hidden h-4 md:block" />
      <nav
        aria-label="Breadcrumb"
        className="hidden min-w-0 items-center gap-1.5 overflow-hidden text-sm md:flex"
      >
        <span className="truncate text-muted-foreground">{scope}</span>
        {project === undefined ? null : <Crumb context>{project}</Crumb>}
        {trail.map((entry, index) => (
          <Crumb key={entry} context={index < trail.length - 1}>
            {entry}
          </Crumb>
        ))}
      </nav>
      <SiteHeaderActionsTarget />
    </header>
  );
}

function Crumb({ context = false, children }: { context?: boolean; children: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", context && "text-muted-foreground")}>
      <span aria-hidden="true" className="text-muted-foreground">
        /
      </span>
      <span className="truncate">{children}</span>
    </span>
  );
}
