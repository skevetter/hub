import type { EditorEvent } from "./configuration/events.js";

const PROGRESS_DESTINATION_EVENTS: ReadonlySet<string> = new Set([
  "github.issue_comment",
  "github.issues",
  "github.pull_request",
  "github.pull_request_review",
  "github.pull_request_review_comment",
  "github.issue_created",
  "github.pull_request_created",
  "github.pull_request_ready_for_review",
  "github.pull_request_synchronized",
  "github.issue_comment_created",
  "github.pull_request_comment_created",
  "github.issue_label_added",
  "github.pull_request_label_added",
  "github.notification",
  "slack.mention",
  "linear.issue_entered_scope",
  "linear.issue_assigned",
  "linear.comment_created",
] satisfies EditorEvent[]);

export function hasProgressDestination(event: string): boolean {
  return PROGRESS_DESTINATION_EVENTS.has(event);
}

export const PROGRESS_DESTINATION_REQUIRED =
  "progress_message needs an event with a place to post: a GitHub issue or pull request event, a GitHub notification, a Slack mention or a Linear event. github.push, manual.run, schedule.tick and Discord events have none.";
