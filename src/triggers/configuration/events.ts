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

export type QualifierKey =
  | "label"
  | "labels"
  | "exclude_labels"
  | "repo"
  | "reason"
  | "project"
  | "states"
  | "assignees"
  | "workspace"
  | "guild"
  | "channels"
  | "pattern"
  | "contains"
  | "exclude_contains"
  | "inputs";

export type QualifierValues = Partial<Record<QualifierKey, string>>;

export interface QualifierDefinition {
  key: QualifierKey;
  kind: "text" | "list" | "inputs";
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
  audience: "wildcard" | "named" | "optional" | "none";
  qualifiers: readonly QualifierDefinition[];
}

function text(key: QualifierKey, label: string, description: string): QualifierDefinition {
  return { key, label, description, kind: "text", required: false };
}

function list(key: QualifierKey, label: string, description: string): QualifierDefinition {
  return { key, label, description, kind: "list", required: false };
}

const INPUTS: QualifierDefinition = {
  key: "inputs",
  kind: "inputs",
  label: "Input matches",
  description:
    'Compare declared input values using a JSON object, for example {"action":"deploy"}.',
  required: false,
};

function event(
  provider: EventDefinition["provider"],
  label: string,
  qualifiers: readonly QualifierDefinition[],
  audience: EventDefinition["audience"],
): EventDefinition {
  return {
    provider,
    label,
    qualifiers,
    audience,
    origin:
      provider === "manual" || provider === "schedule" || provider === "github_notification"
        ? "hub"
        : "provider",
  };
}

const REPO = text("repo", "Repository", "Use owner/name. Leave blank for any repository.");
const ADDED_LABEL = text("label", "Added label", "Match the label added by this event.");
const GITHUB_LABELS = list(
  "labels",
  "Required labels",
  "Use GitHub label names. All must be present.",
);
const CHANNELS = list("channels", "Channels", "Use channel IDs. Any listed channel can match.");

function textFilters(subject: string) {
  return [
    text("pattern", `${subject} starts with`, "Match a literal prefix."),
    text("contains", `${subject} contains`, "Match literal text anywhere in the value."),
  ];
}

function github(label: string, subject: string, addedLabel?: "required" | "optional") {
  return event(
    "github",
    label,
    [
      REPO,
      ...(addedLabel === undefined
        ? []
        : [{ ...ADDED_LABEL, required: addedLabel === "required" }]),
      GITHUB_LABELS,
      ...textFilters(subject),
      text("exclude_contains", `${subject} excludes`, "Skip events containing this literal text."),
      INPUTS,
    ],
    "wildcard",
  );
}

function linear(label: string, kind: "scope" | "assignment" | "comment") {
  const project = text("project", "Project", "Use the Linear project ID.");
  return event(
    "linear",
    label,
    [
      { ...project, required: kind === "scope" },
      list("states", "Workflow states", "Use Linear state IDs. Any listed state can match."),
      list("assignees", "Assignees", "Use Linear user IDs. Any listed assignee can match."),
      list("labels", "Required labels", "Use Linear label IDs. All must be present."),
      list(
        "exclude_labels",
        "Excluded labels",
        "Use Linear label IDs. Any listed label skips the event.",
      ),
      ...(kind === "comment" ? textFilters("Comment") : []),
      INPUTS,
    ],
    kind === "scope" ? "optional" : "named",
  );
}

function mention(provider: "slack" | "discord", label: string, scope: QualifierDefinition) {
  return event(
    provider,
    label,
    [
      scope,
      CHANNELS,
      text("pattern", "Command prefix", "Match a command immediately after the bot mention."),
      text(
        "contains",
        "Fallback command prefix",
        "Used when Command prefix is blank. Matches immediately after the bot mention.",
      ),
      INPUTS,
    ],
    "wildcard",
  );
}

const EVENTS = {
  "slack.mention": mention(
    "slack",
    "Slack mention",
    text("workspace", "Workspace", "Use the Slack workspace ID."),
  ),
  "discord.mention": mention(
    "discord",
    "Discord mention",
    text("guild", "Server", "Use the Discord server ID."),
  ),
  "github.issue_created": github("GitHub issue created", "Issue text"),
  "github.pull_request_created": github("GitHub pull request created", "Pull request text"),
  "github.pull_request_ready_for_review": github(
    "GitHub pull request ready for review",
    "Pull request text",
  ),
  "github.pull_request_synchronized": github(
    "GitHub pull request updated with new commits",
    "Pull request text",
  ),
  "github.issue_comment_created": github("GitHub issue comment created", "Comment"),
  "github.pull_request_comment_created": github("GitHub pull request comment created", "Comment"),
  "github.issue_label_added": github("GitHub issue label added", "Issue text", "required"),
  "github.pull_request_label_added": github(
    "GitHub pull request label added",
    "Pull request text",
    "required",
  ),
  "github.issue_comment": github("GitHub issue or PR comment webhook", "Comment"),
  "github.issues": github("GitHub issue webhook", "Issue text", "optional"),
  "github.pull_request": github("GitHub pull request webhook", "Pull request text", "optional"),
  "github.pull_request_review": github("GitHub pull request review webhook", "Review"),
  "github.pull_request_review_comment": github("GitHub review comment webhook", "Comment"),
  "github.push": event("github", "GitHub push", [REPO, INPUTS], "wildcard"),
  "linear.issue_entered_scope": linear("Linear issue entered scope", "scope"),
  "linear.issue_assigned": linear("Linear issue assigned", "assignment"),
  "linear.comment_created": linear("Linear comment created", "comment"),
  "github.notification": event(
    "github_notification",
    "GitHub notification",
    [
      REPO,
      text(
        "reason",
        "Reason",
        "Use a GitHub notification reason such as mention or review_requested.",
      ),
      ...textFilters("Title"),
    ],
    "none",
  ),
  "schedule.tick": event("schedule", "Schedule", [], "none"),
  "manual.run": event("manual", "Manual run", [INPUTS], "wildcard"),
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
