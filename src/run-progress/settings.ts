export interface RunProgressSettings {
  readonly runTimelineEnabled: boolean;
  readonly runStreamEnabled: boolean;
  readonly progressMessagesEnabled: boolean;
  readonly githubToken?: string;
  readonly githubOrgs: Readonly<Record<string, readonly string[]>>;
  readonly publicRepos: "refuse" | "allow";
  readonly timelineMaxEvents: number;
  readonly retentionDays: number;
  readonly minEditSeconds: number;
  readonly maxEdits: number;
  readonly streamMaxPerKey: number;
  readonly streamMaxPerOrg: number;
  readonly streamMaxTotal: number;
  readonly streamHeartbeatSeconds: number;
  readonly streamMaxSeconds: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function readRunProgressSettings(environment: Environment): RunProgressSettings {
  const githubToken = environment["PASEO_HUB_PROGRESS_GITHUB_TOKEN"]?.trim() || undefined;
  const settings: RunProgressSettings = {
    runTimelineEnabled: readBoolean(environment, "PASEO_HUB_RUN_TIMELINE"),
    runStreamEnabled: readBoolean(environment, "PASEO_HUB_RUN_STREAM"),
    progressMessagesEnabled: readBoolean(environment, "PASEO_HUB_PROGRESS_MESSAGES"),
    ...(githubToken === undefined ? {} : { githubToken }),
    githubOrgs: readGitHubOrganizations(environment["PASEO_HUB_PROGRESS_GITHUB_ORGS"]),
    publicRepos: readPublicRepositories(environment["PASEO_HUB_PROGRESS_PUBLIC_REPOS"]),
    timelineMaxEvents: readInteger(environment, "PASEO_HUB_TIMELINE_MAX_EVENTS", 500, 50, 5000),
    retentionDays: readInteger(environment, "PASEO_HUB_TIMELINE_RETENTION_DAYS", 30, 1, 365),
    minEditSeconds: readInteger(environment, "PASEO_HUB_PROGRESS_MIN_EDIT_SECONDS", 20, 5, 600),
    maxEdits: readInteger(environment, "PASEO_HUB_PROGRESS_MAX_EDITS", 120, 10, 1000),
    streamMaxPerKey: readInteger(environment, "PASEO_HUB_STREAM_MAX_PER_KEY", 5, 1, 100),
    streamMaxPerOrg: readInteger(environment, "PASEO_HUB_STREAM_MAX_PER_ORG", 20, 1, 500),
    streamMaxTotal: readInteger(environment, "PASEO_HUB_STREAM_MAX_TOTAL", 200, 1, 2000),
    streamHeartbeatSeconds: readInteger(
      environment,
      "PASEO_HUB_STREAM_HEARTBEAT_SECONDS",
      15,
      5,
      60,
    ),
    streamMaxSeconds: readInteger(environment, "PASEO_HUB_STREAM_MAX_SECONDS", 3600, 60, 86400),
  };
  if (settings.runStreamEnabled && !settings.runTimelineEnabled) {
    throw new Error("PASEO_HUB_RUN_STREAM needs PASEO_HUB_RUN_TIMELINE=true.");
  }
  if (settings.progressMessagesEnabled && !settings.runTimelineEnabled) {
    throw new Error("PASEO_HUB_PROGRESS_MESSAGES needs PASEO_HUB_RUN_TIMELINE=true.");
  }
  if (githubToken !== undefined && Object.keys(settings.githubOrgs).length === 0) {
    throw new Error("PASEO_HUB_PROGRESS_GITHUB_TOKEN needs PASEO_HUB_PROGRESS_GITHUB_ORGS.");
  }
  return settings;
}

function readBoolean(environment: Environment, name: string): boolean {
  const raw = environment[name];
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${name} must be true or false.`);
}

function readInteger(
  environment: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function readPublicRepositories(raw: string | undefined): "refuse" | "allow" {
  const value = raw?.trim();
  if (value === undefined || value === "" || value === "refuse") return "refuse";
  if (value === "allow") return "allow";
  throw new Error("PASEO_HUB_PROGRESS_PUBLIC_REPOS must be refuse or allow.");
}

function readGitHubOrganizations(
  raw: string | undefined,
): Readonly<Record<string, readonly string[]>> {
  const value = raw?.trim();
  const organizations: Record<string, readonly string[]> = {};
  if (value === undefined || value === "") return Object.freeze(organizations);
  let patternCount = 0;
  for (const [index, entry] of value.split(";").entries()) {
    const position = index + 1;
    const invalid = (reason: string): Error =>
      new Error(`PASEO_HUB_PROGRESS_GITHUB_ORGS entry ${position}: ${reason}.`);
    if (position > 20) throw invalid("at most 20 organizations are allowed");
    const match =
      /^([a-z0-9][a-z0-9-]*):([A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)(?:,[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*))*)$/u.exec(
        entry,
      );
    if (match === null || match[0] !== entry) throw invalid("expected slug:owner/name,owner/*");
    const slug = match[1]!;
    if (Object.hasOwn(organizations, slug)) throw invalid("duplicate organization slug");
    const patterns = match[2]!.toLowerCase().split(",");
    patternCount += patterns.length;
    if (patternCount > 100) throw invalid("at most 100 repository patterns are allowed");
    organizations[slug] = Object.freeze(patterns);
  }
  return Object.freeze(organizations);
}
