import { useCallback } from "react";
import { parseThemeChoice, useTheme } from "../../theme/index.js";
import { SegmentedControl } from "./segmented-control.js";

const OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const select = useCallback((value: string) => setChoice(parseThemeChoice(value)), [setChoice]);
  return <SegmentedControl label="Theme" value={choice} options={OPTIONS} onChange={select} />;
}
