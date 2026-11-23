import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { InitialThemeContext } from "../../theme/index.js";
import type * as SegmentedControlModule from "./segmented-control.js";
import { ThemeSwitch } from "./theme-switch.js";

const state = vi.hoisted(() => ({
  onChange: undefined as ((value: string) => void) | undefined,
}));

vi.mock("./segmented-control.js", async (importOriginal) => {
  const original = await importOriginal<typeof SegmentedControlModule>();
  return {
    SegmentedControl: (props: Parameters<typeof original.SegmentedControl>[0]) => {
      state.onChange = props.onChange;
      return <original.SegmentedControl {...props} />;
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

it("renders a named radio group and checks the initial theme", () => {
  const markup = renderToStaticMarkup(
    <InitialThemeContext value="dark">
      <ThemeSwitch />
    </InitialThemeContext>,
  );
  expect(markup).toContain('role="radiogroup" aria-label="Theme"');
  expect(markup).toMatch(/aria-checked="false"[^>]*>System<\/button>/u);
  expect(markup).toMatch(/aria-checked="false"[^>]*>Light<\/button>/u);
  expect(markup).toMatch(/aria-checked="true"[^>]*>Dark<\/button>/u);
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
