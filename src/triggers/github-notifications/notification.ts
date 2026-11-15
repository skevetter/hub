import { z } from "zod";

/** One thread from `GET /notifications`. Unknown fields are dropped, comment text never exists here. */
export const GitHubNotificationThreadSchema = z.object({
  id: z.string().min(1),
  reason: z.string(),
  updated_at: z.string().min(1),
  subject: z.object({
    title: z.string(),
    url: z.string().nullable().optional(),
    type: z.string(),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
});

export type GitHubNotificationThread = z.infer<typeof GitHubNotificationThreadSchema>;

/** What Hub stores and hands to the run. Nothing else from the thread is kept. */
export interface NotificationPayload {
  repo: string;
  thread_id: string;
  subject_type: string;
  title: string;
  number: number | null;
  html_url: string | null;
  reason: string;
  updated_at: string;
}

const SUBJECT_NUMBER = /\/(?:pulls|issues)\/(\d+)$/u;

export function toNotificationPayload(thread: GitHubNotificationThread): NotificationPayload {
  const repo = thread.repository.full_name;
  const matched = SUBJECT_NUMBER.exec(thread.subject.url ?? "")?.[1];
  const number = matched === undefined ? null : Number(matched);
  return {
    repo,
    thread_id: thread.id,
    subject_type: thread.subject.type,
    title: thread.subject.title,
    number,
    html_url: htmlUrl(repo, thread.subject.type, number),
    reason: thread.reason,
    updated_at: thread.updated_at,
  };
}

function htmlUrl(repo: string, type: string, number: number | null): string | null {
  if (number === null) return null;
  if (type === "PullRequest") return `https://github.com/${repo}/pull/${String(number)}`;
  if (type === "Issue") return `https://github.com/${repo}/issues/${String(number)}`;
  return null;
}

/** Receipts are unique per organization and delivery id, so a repeat poll cannot start a second run. */
export function notificationDeliveryId(payload: NotificationPayload): string {
  return `${payload.thread_id}:${payload.updated_at}`;
}
