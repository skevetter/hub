import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  cycleTheme,
  DARK_QUERY,
  parseThemeChoice,
  readThemeCookie,
  THEME_CHANGE,
  THEME_SCRIPT,
} from "./preference.js";

describe("theme choice", () => {
  it.each(["light", "dark", "system"])("accepts %s", (choice) => {
    expect(parseThemeChoice(choice)).toBe(choice);
  });

  it.each(["", "Dark", "unknown", undefined])("treats %s as System", (choice) => {
    expect(parseThemeChoice(choice)).toBe("system");
  });

  it("reads only the theme cookie", () => {
    expect(readThemeCookie("other_theme=dark; theme=light; other=dark")).toBe("light");
    expect(readThemeCookie("other_theme=dark")).toBe("system");
  });

  it("cycles System, Light, Dark, then System", () => {
    expect(cycleTheme("system")).toBe("light");
    expect(cycleTheme("light")).toBe("dark");
    expect(cycleTheme("dark")).toBe("system");
  });
});

it("applies System before paint and respects explicit choices on OS changes", () => {
  const classList = { toggle: vi.fn() };
  const document = { cookie: "", documentElement: { classList } };
  const media = {
    matches: true,
    addEventListener: vi.fn<(type: string, fn: () => void) => void>(),
  };
  const matchMedia = vi.fn(() => media);
  const window = { dispatchEvent: vi.fn<(event: Event) => void>() };

  runInNewContext(THEME_SCRIPT, { document, window, matchMedia, Event });
  expect(matchMedia).toHaveBeenCalledWith(DARK_QUERY);
  expect(classList.toggle.mock.calls).toEqual([
    ["dark", true],
    ["light", false],
  ]);

  const [event, onChange] = media.addEventListener.mock.calls[0]!;
  expect(event).toBe("change");
  media.matches = false;
  onChange();
  expect(classList.toggle).toHaveBeenLastCalledWith("light", true);
  expect(window.dispatchEvent.mock.calls[0]?.[0].type).toBe(THEME_CHANGE);

  document.cookie = "theme=light";
  media.matches = true;
  onChange();
  expect(classList.toggle).toHaveBeenLastCalledWith("light", true);
});
