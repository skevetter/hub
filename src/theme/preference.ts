const SYSTEM = "system";
const LIGHT = "light";
const DARK = "dark";

export type ResolvedTheme = typeof LIGHT | typeof DARK;
export type ThemeChoice = typeof SYSTEM | ResolvedTheme;

const THEME_COOKIE = "theme";
const COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=([^;]*)`, "u");
const COOKIE_ATTRIBUTES = "Path=/; Max-Age=31536000; SameSite=Lax";
export const DARK_QUERY = "(prefers-color-scheme: dark)";
export const THEME_CHANGE = "hub:theme-change";

export function parseThemeChoice(value: string | undefined): ThemeChoice {
  return value === LIGHT || value === DARK ? value : SYSTEM;
}

export function readThemeCookie(cookies: string | null): ThemeChoice {
  return parseThemeChoice(cookies?.match(COOKIE_PATTERN)?.[1]);
}

export function themeCookie(choice: ThemeChoice): string {
  return `${THEME_COOKIE}=${choice}; ${COOKIE_ATTRIBUTES}`;
}

export function cycleTheme(choice: ThemeChoice): ThemeChoice {
  if (choice === SYSTEM) return LIGHT;
  return choice === LIGHT ? DARK : SYSTEM;
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice !== SYSTEM) return choice;
  return prefersDark ? DARK : LIGHT;
}

export const THEME_SCRIPT = `(()=>{
const media=matchMedia(${JSON.stringify(DARK_QUERY)}),root=document.documentElement;
function apply(){
const choice=document.cookie.match(${COOKIE_PATTERN.toString()})?.[1];
const dark=choice===${JSON.stringify(DARK)}||(choice!==${JSON.stringify(LIGHT)}&&media.matches);
root.classList.toggle(${JSON.stringify(DARK)},dark);
root.classList.toggle(${JSON.stringify(LIGHT)},!dark);
}
apply();
media.addEventListener("change",()=>{
apply();
window.dispatchEvent(new Event(${JSON.stringify(THEME_CHANGE)}));
});
})();`;
