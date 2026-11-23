import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { InitialThemeContext } from "../../theme/index.js";
import type * as DropdownModule from "../ui/dropdown-menu.js";
import { ThemeSwitch } from "./theme-switch.js";

const state = vi.hoisted(() => ({
  onChange: undefined as ((value: string) => void) | undefined,
}));

vi.mock("../ui/dropdown-menu.js", async (importOriginal) => {
  const original = await importOriginal<typeof DropdownModule>();
  return {
    DropdownMenuLabel: original.DropdownMenuLabel,
    DropdownMenuRadioGroup: (props: Parameters<typeof original.DropdownMenuRadioGroup>[0]) => {
      state.onChange = props.onValueChange;
      return (
        <div aria-label={props["aria-label"]} data-value={props.value}>
          {props.children}
        </div>
      );
    },
    DropdownMenuRadioItem: (props: Parameters<typeof original.DropdownMenuRadioItem>[0]) => {
      return <div data-choice={props.value}>{props.children}</div>;
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

it("passes the initial theme and all three choices to the menu", () => {
  const markup = renderToStaticMarkup(
    <InitialThemeContext value="dark">
      <ThemeSwitch />
    </InitialThemeContext>,
  );
  expect(markup).toContain('aria-label="Theme" data-value="dark"');
  expect(markup).toContain('data-choice="system">System');
  expect(markup).toContain('data-choice="light">Light');
  expect(markup).toContain('data-choice="dark">Dark');
});

it("persists and applies a selection immediately", () => {
  const toggle = vi.fn();
  const document = { cookie: "", documentElement: { classList: { toggle } } };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), dispatchEvent: vi.fn() });

  renderToStaticMarkup(<ThemeSwitch />);
  expect(state.onChange).toBeTypeOf("function");
  state.onChange?.("light");

  expect(document.cookie).toBe("theme=light; Path=/; Max-Age=31536000; SameSite=Lax");
  expect(toggle.mock.calls).toEqual([
    ["light", true],
    ["dark", false],
  ]);
});
