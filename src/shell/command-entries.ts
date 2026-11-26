import { defaultFilter } from "cmdk";

export interface CommandAction {
  to: string;
  label: string;
  keywords: string[];
}

interface ActionAccess {
  slug: string;
  manageResources: boolean;
  sessionsEnabled: boolean;
}

// Words people type for a page whose label does not contain them. Keyed by the route path
// after the organization prefix.
const PAGE_KEYWORDS: Readonly<Record<string, string[]>> = {
  triggers: ["webhook", "automation", "event", "schedule"],
  connections: ["webhook", "provider", "github", "slack", "discord", "linear", "integration"],
  daemons: ["agent", "machine", "host"],
  "sessions/profiles": ["session profile", "agent profile"],
  "settings/team": ["members", "invite", "people", "roles"],
  "settings/api-keys": ["api key", "token", "secret", "credential", "webhook"],
  "settings/usage": ["quota", "limits", "execution"],
  "settings/billing": ["plan", "subscription", "payment", "invoice"],
  "settings/instance/apps": ["provider application", "oauth", "webhook"],
  "settings/instance/operator": ["admin", "instance"],
};

const NO_KEYWORDS: string[] = [];

export function pageKeywords(slug: string, to: string): string[] {
  const prefix = `/o/${slug}/`;
  return to.startsWith(prefix)
    ? (PAGE_KEYWORDS[to.slice(prefix.length)] ?? NO_KEYWORDS)
    : NO_KEYWORDS;
}

// Each action opens a page that exists; the dialog or editor on it takes over from there.
// Labels keep cmdk's fuzzy match. Keywords match as plain substrings, so a stray letter run in a
// word like "webhook" cannot pull an unrelated page into a search for an organization name.
export function matchCommand(value: string, search: string, keywords?: string[]): number {
  const labelScore = defaultFilter(value, search);
  if (labelScore > 0) return labelScore;
  const needle = search.trim().toLowerCase();
  if (needle === "") return 0;
  return keywords?.some((word) => word.toLowerCase().includes(needle)) === true ? 0.1 : 0;
}

export function commandActions({
  slug,
  manageResources,
  sessionsEnabled,
}: ActionAccess): CommandAction[] {
  const base = `/o/${slug}`;
  return [
    ...(manageResources
      ? [
          {
            to: `${base}/triggers/new/edit`,
            label: "New trigger",
            keywords: ["create", "add", "webhook"],
          },
          {
            to: `${base}/settings/api-keys`,
            label: "Create API key",
            keywords: ["new", "add", "token", "secret", "webhook"],
          },
        ]
      : []),
    ...(sessionsEnabled
      ? [{ to: `${base}/sessions/new`, label: "New session", keywords: ["create", "start"] }]
      : []),
  ];
}
