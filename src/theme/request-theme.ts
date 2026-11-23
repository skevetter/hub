import { createMiddleware } from "@tanstack/react-start";
import { readThemeCookie, type ThemeChoice } from "./preference.js";

interface ThemeServerContext {
  themeChoice: ThemeChoice;
}

export function readRequestTheme(request: Request): ThemeChoice {
  return readThemeCookie(request.headers.get("cookie"));
}

export const requestTheme = createMiddleware().server(({ next, request }) =>
  next({ context: { themeChoice: readRequestTheme(request) } }),
);

export function initialTheme({
  serverContext,
}: {
  serverContext?: ThemeServerContext | undefined;
}): ThemeChoice {
  return serverContext?.themeChoice ?? "system";
}
