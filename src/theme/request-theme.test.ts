import { expect, it } from "vitest";
import { initialTheme, readRequestTheme } from "./request-theme.js";

it.each([
  [undefined, "system"],
  ["other=value; theme=light", "light"],
  ["theme=dark", "dark"],
  ["theme=system", "system"],
  ["theme=invalid", "system"],
])("reads the server theme from Cookie: %s", (cookie, expected) => {
  const headers = cookie === undefined ? {} : { cookie };
  const themeChoice = readRequestTheme(new Request("https://hub.example/", { headers }));
  expect(themeChoice).toBe(expected);
  expect(initialTheme({ serverContext: { themeChoice } })).toBe(expected);
});

it("uses System when the router loads without a server request", () => {
  expect(initialTheme({})).toBe("system");
});
