export const NOTIFICATION_FROM_USERS_MESSAGE =
  "github.notification has no commenter or author, so it does not accept from_users.";

/** The filters the notification poll can evaluate. Anything else would be ignored silently. */
export const NOTIFICATION_FILTER_KEYS = ["repo", "reason", "contains", "pattern"] as const;

/**
 * The notification reasons a script may run for. They are the ones tied to the user's own work: a
 * thread they created, an assignment, a review request, a state change, a CI result. This does not
 * make them outsider-proof. On a public repository anyone can comment on a thread the user created
 * (reason `author`), change the state of a thread the user follows (`state_change`), and push code
 * that starts a run the user is told about (`ci_activity`, possibly). The excluded reasons are the
 * ones anyone can cause at will, such as a mention. The script text stays fixed, so an outsider
 * controls only when the script runs and what `HUB_EVENT_JSON` holds. That is why event data is
 * untrusted and why script triggers belong on private repositories.
 */
export const SCRIPT_NOTIFICATION_REASONS = [
  "author",
  "assign",
  "review_requested",
  "state_change",
  "ci_activity",
] as const;

/** The YAML filter keys the form knows how to qualify. */
export type QualifierKey = "label" | "repo" | "reason";

/** Draft values for the qualifiers declared by the selected event. */
export type QualifierValues = Partial<Record<QualifierKey, string>>;

export interface QualifierDefinition {
  key: QualifierKey;
  kind: "string";
  label: string;
  description: string;
  required: boolean;
}

interface EventDefinition {
  provider:
    | "github"
    | "slack"
    | "discord"
    | "linear"
    | "manual"
    | "schedule"
    | "github_notification";
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
}

const ADDED_LABEL: QualifierDefinition = {
  key: "label",
  kind: "string",
  label: "Added label",
  description:
    "Match the label added by this event, not labels already on the issue or pull request.",
  required: true,
};

function event(
  provider: EventDefinition["provider"],
  label: string,
  qualifiers: readonly QualifierDefinition[] = [],
): EventDefinition {
  return {
    provider,
    label,
    qualifiers,
    origin:
      provider === "manual" || provider === "schedule" || provider === "github_notification"
        ? "hub"
        : "provider",
  };
}

const NOTIFICATION_REPO: QualifierDefinition = {
  key: "repo",
  kind: "string",
  label: "Repository",
  description: "Match notifications from this repository, as owner/name. Leave blank for any.",
  required: false,
};

const NOTIFICATION_REASON: QualifierDefinition = {
  key: "reason",
  kind: "string",
  label: "Reason",
  description:
    "Match GitHub's reason for the notification, such as mention or review_requested. Leave blank for any.",
  required: false,
};

const EVENTS = {
  "slack.mention": event("slack", "Slack mention"),
  "discord.mention": event("discord", "Discord mention"),
  "github.issue_created": event("github", "GitHub issue created"),
  "github.pull_request_created": event("github", "GitHub pull request created"),
  "github.pull_request_ready_for_review": event("github", "GitHub pull request ready for review"),
  "github.pull_request_synchronized": event(
    "github",
    "GitHub pull request updated with new commits",
  ),
  "github.issue_comment_created": event("github", "GitHub issue comment created"),
  "github.pull_request_comment_created": event("github", "GitHub pull request comment created"),
  "github.issue_label_added": event("github", "GitHub issue label added", [ADDED_LABEL]),
  "github.pull_request_label_added": event("github", "GitHub pull request label added", [
    ADDED_LABEL,
  ]),
  "github.issue_comment": event("github", "GitHub issue or PR comment webhook"),
  "github.issues": event("github", "GitHub issue webhook"),
  "github.pull_request": event("github", "GitHub pull request webhook"),
  "github.pull_request_review": event("github", "GitHub pull request review webhook"),
  "github.pull_request_review_comment": event("github", "GitHub review comment webhook"),
  "github.push": event("github", "GitHub push"),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope"),
  "linear.issue_assigned": event("linear", "Linear issue assigned"),
  "linear.comment_created": event("linear", "Linear comment created"),
  "github.notification": event("github_notification", "GitHub notification", [
    NOTIFICATION_REPO,
    NOTIFICATION_REASON,
  ]),
  "schedule.tick": event("schedule", "Schedule"),
  "manual.run": event("manual", "Manual run"),
};

export type EditorEvent = keyof typeof EVENTS;
export const EDITOR_EVENTS = Object.keys(EVENTS).filter(isEditorEvent);

export function isEditorEvent(value: string): value is EditorEvent {
  return Object.hasOwn(EVENTS, value);
}

export function parseEditorEvent(value: string): EditorEvent {
  return isEditorEvent(value) ? value : "manual.run";
}

export function eventDefinition(eventId: EditorEvent): EventDefinition {
  return EVENTS[eventId];
}
