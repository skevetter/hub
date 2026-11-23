import { useCallback } from "react";
import { parseThemeChoice, THEME_OPTIONS, useTheme } from "../../theme/index.js";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu.js";

export function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const select = useCallback((value: string) => setChoice(parseThemeChoice(value)), [setChoice]);
  return (
    <DropdownMenuRadioGroup aria-label="Theme" value={choice} onValueChange={select}>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      {THEME_OPTIONS.map(({ value, label }) => (
        <DropdownMenuRadioItem key={value} value={value}>
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
