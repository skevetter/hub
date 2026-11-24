import { createContext, useContext, useSyncExternalStore } from "react";
import {
  DARK_QUERY,
  THEME_CHANGE,
  readThemeCookie,
  resolveTheme,
  themeCookie,
  type ThemeChoice,
} from "./preference.js";

export { cycleTheme, parseThemeChoice, type ThemeChoice } from "./preference.js";

export const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export const InitialThemeContext = createContext<ThemeChoice>("system");

const SYSTEM_DARK = "system-dark";

function readSnapshot() {
  const choice = readThemeCookie(document.cookie);
  if (choice === "system" && document.documentElement.classList.contains("dark")) {
    return SYSTEM_DARK;
  }
  return choice;
}

function subscribe(listener: () => void) {
  window.addEventListener(THEME_CHANGE, listener);
  return () => window.removeEventListener(THEME_CHANGE, listener);
}

function setChoice(choice: ThemeChoice): void {
  document.cookie = themeCookie(choice, window.location.protocol === "https:");
  const resolved = resolveTheme(choice, window.matchMedia(DARK_QUERY).matches);
  const root = document.documentElement;
  root.classList.toggle("light", resolved === "light");
  root.classList.toggle("dark", resolved === "dark");
  window.dispatchEvent(new Event(THEME_CHANGE));
}

export function useTheme() {
  const initialChoice = useContext(InitialThemeContext);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, () => initialChoice);
  const choice = snapshot === SYSTEM_DARK ? "system" : snapshot;
  return { choice, resolved: resolveTheme(choice, snapshot === SYSTEM_DARK), setChoice };
}
