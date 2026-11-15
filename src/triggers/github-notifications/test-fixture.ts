import type { GitHubNotificationThread } from "./notification.js";

export function thread(
  overrides: {
    id?: string;
    reason?: string;
    updated_at?: string;
    title?: string;
    type?: string;
    url?: string | null;
    repo?: string;
  } = {},
): GitHubNotificationThread {
  const repo = overrides.repo ?? "ThermAI-Group/flightdeck";
  return {
    id: overrides.id ?? "1001",
    reason: overrides.reason ?? "mention",
    updated_at: overrides.updated_at ?? "2026-11-14T10:00:00Z",
    subject: {
      title: overrides.title ?? "Fix the flaky deploy check",
      url:
        overrides.url === undefined
          ? `https://api.github.com/repos/${repo}/pulls/42`
          : overrides.url,
      type: overrides.type ?? "PullRequest",
    },
    repository: { full_name: repo },
  };
}

export function notificationYaml(name: string, filters = "", enabled = true): string {
  return `name: ${name}
enabled: ${String(enabled)}
on:
  github.notification:${filters === "" ? " {}" : `\n    filters:\n${filters}`}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access, thinkingOptionId: low }
  prompt: 'Look at \${{ paseo.context }}'
`;
}
