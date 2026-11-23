import { useState, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  Link,
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { PageHeader } from "../components/app/page.js";
import { Button } from "../components/ui/button.js";
import { InitialThemeContext } from "../theme/index.js";
import { THEME_SCRIPT } from "../theme/preference.js";
import { initialTheme, requestTheme } from "../theme/request-theme.js";
import "../styles.entry.js";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  server: { middleware: [requestTheme] },
  loader: initialTheme,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "referrer", content: "same-origin" },
      { title: "Paseo Hub" },
    ],
    links: [
      {
        rel: "icon",
        href: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><circle cx=%2216%22 cy=%2216%22 r=%2214%22 fill=%22%23fafafa%22/><path d=%22M10 9h7a6 6 0 0 1 0 12h-3v4h-4V9zm4 4v4h3a2 2 0 1 0 0-4h-3z%22 fill=%22%2309090b%22/></svg>",
      },
    ],
  }),
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <main className="grid min-h-svh place-items-center px-6 py-16">
      <div className="grid max-w-md gap-4">
        <PageHeader
          title="Page not found"
          description="This address does not match a page in Paseo Hub. Check the address or return home."
        />
        <div>
          <Button asChild>
            <Link to="/">Return home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

function Document({ children }: { children: ReactNode }) {
  const loaderChoice = Route.useLoaderData();
  // The script and hook own this class after the initial render.
  const [choice] = useState(loaderChoice);
  return (
    <html lang="en" className={choice === "system" ? undefined : choice} suppressHydrationWarning>
      <head>
        <script>{THEME_SCRIPT}</script>
        <HeadContent />
      </head>
      <body>
        <InitialThemeContext value={choice}>{children}</InitialThemeContext>
        <Scripts />
      </body>
    </html>
  );
}
