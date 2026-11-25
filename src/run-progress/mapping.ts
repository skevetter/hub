export function readGitHubOrganizations(
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
    const { slug, rawPatterns } = parseOrganizationEntry(entry, invalid);
    if (Object.hasOwn(organizations, slug)) throw invalid("duplicate organization slug");
    const patterns = rawPatterns.toLowerCase().split(",");
    patternCount += patterns.length;
    if (patternCount > 100) throw invalid("at most 100 repository patterns are allowed");
    organizations[slug] = Object.freeze(patterns);
  }
  return Object.freeze(organizations);
}

function parseOrganizationEntry(entry: string, invalid: (reason: string) => Error) {
  const match =
    /^([a-z0-9][a-z0-9-]*):([A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)(?:,[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*))*)$/u.exec(
      entry,
    );
  if (match === null || match[0] !== entry) throw invalid("expected slug:owner/name,owner/*");
  const [, slug, rawPatterns] = match;
  if (slug === undefined || rawPatterns === undefined)
    throw new Error("run progress mapping invariant: expected organization slug and patterns");
  return { slug, rawPatterns };
}

export function allowsGitHubRepository(patterns: readonly string[], repository: string): boolean {
  const fullName = repository.toLowerCase();
  const owner = fullName.split("/")[0];
  return patterns.includes(fullName) || patterns.includes(`${owner}/*`);
}
