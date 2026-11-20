import { parseDocument } from "yaml";

import { recurrenceSummary } from "../schedule/recurrence.js";
import { eventDefinition, isEditorEvent, type QualifierDefinition } from "./events.js";
import { isScriptRun, TriggerDocumentSchema, type TriggerDocument } from "./schema.js";

const alternatives = new Intl.ListFormat("en", { type: "disjunction" });
const together = new Intl.ListFormat("en", { type: "conjunction" });

const EVENTS: Readonly<Record<string, string>> = {
  "github.issue_created": "a GitHub issue is opened",
  "github.pull_request_created": "a GitHub pull request is opened",
  "github.pull_request_ready_for_review": "a GitHub pull request is marked ready for review",
  "github.pull_request_synchronized": "new commits are pushed to a GitHub pull request",
  "github.issue_comment_created": "a comment is added to a GitHub issue",
  "github.pull_request_comment_created": "a comment is added to a GitHub pull request",
  "github.issue_comment": "a GitHub issue or pull request comment event arrives",
  "github.issue_label_added": "a label is added to a GitHub issue",
  "github.pull_request_label_added": "a label is added to a GitHub pull request",
  "github.issues": "a GitHub issue event arrives",
  "github.pull_request": "a GitHub pull request event arrives",
  "github.pull_request_review": "a GitHub pull request review event arrives",
  "github.pull_request_review_comment": "a GitHub review comment event arrives",
  "github.push": "GitHub receives a push",
  "linear.issue_assigned": "a Linear issue is assigned or delegated to the Hub app",
  "linear.issue_entered_scope": "a Linear issue enters the configured scope",
  "linear.comment_created": "a comment is added to a Linear issue",
  "github.notification": "a GitHub notification arrives",
  "manual.run": "a manual or webhook request arrives",
  "schedule.tick": "a scheduled run is due",
  "slack.mention": "the app is mentioned in Slack",
  "discord.mention": "the bot is mentioned in Discord",
};

export function triggerEventClause(event: string): string {
  return (
    EVENTS[event] ??
    `a ${isEditorEvent(event) ? eventDefinition(event).label : event} event arrives`
  );
}

export function describeTrigger(document: TriggerDocument): string {
  const events = Object.entries(document.on).map(([event, definition]) => {
    if (event === "schedule.tick" && definition.recurrence !== undefined) {
      const schedule = recurrenceSummary(definition.recurrence);
      return schedule.startsWith("Every")
        ? schedule
        : `On the configured schedule in ${definition.recurrence.timezone}`;
    }
    return `When ${triggerEventClause(event)}${describeFilters(event, definition.filters)}`;
  });
  const run = document.run;
  const conditions = alternatives.format(
    events.map((condition, index) =>
      index === 0 ? condition : condition.charAt(0).toLowerCase() + condition.slice(1),
    ),
  );
  return `${conditions}, run ${describeAction(run)} on host ${run.target.daemon}.`;
}

function describeAction(run: TriggerDocument["run"]): string {
  if (isScriptRun(run)) return "a script";
  if ("choices" in run.agent) return "the selected agent";
  const { provider, model } = run.agent;
  return model === undefined ? provider : `${provider}/${model}`;
}

type Filters = TriggerDocument["on"][string]["filters"];

function describeFilters(event: string, filters: Filters): string {
  if (filters === undefined || !isEditorEvent(event)) return "";
  const definition = eventDefinition(event);
  const prefixCommand = definition.provider === "slack" || definition.provider === "discord";
  const names = filters.from_users ?? [];
  const clauses = [];
  if (
    definition.audience !== "none" &&
    names.length > 0 &&
    !(definition.audience === "wildcard" && names.includes("*"))
  ) {
    clauses.push(`from ${alternatives.format(names)}`);
  }
  for (const qualifier of definition.qualifiers) {
    if (prefixCommand && qualifier.key === "contains" && filters.pattern) continue;
    const value = filters[qualifier.key];
    const clause = describeQualifier(qualifier, value, prefixCommand);
    if (clause !== undefined) clauses.push(clause);
  }
  return clauses.length === 0 ? "" : ` ${clauses.join(" ")}`;
}

function describeQualifier(
  { key, label }: QualifierDefinition,
  value: NonNullable<Filters>[QualifierDefinition["key"]],
  prefixCommand: boolean,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const name = label.toLowerCase();
  if (typeof value === "string") {
    if (key === "repo" || key === "project") return `in ${name} ${value}`;
    if (prefixCommand && (key === "pattern" || key === "contains")) {
      return `with command prefix ${JSON.stringify(value)}`;
    }
    if (key === "pattern" || key === "contains" || key === "exclude_contains") {
      return `and the ${name} ${JSON.stringify(value)}`;
    }
    return `with ${name} ${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const format = key === "labels" ? together : alternatives;
    if (key === "exclude_labels") return `without labels ${format.format(value)}`;
    return `with ${name} ${format.format(value)}`;
  }
  return Object.keys(value).length === 0 ? undefined : "with matching inputs";
}

export function describeTriggerYaml(yaml: string): string | undefined {
  if (yaml.trim() === "") return undefined;
  try {
    const document = parseDocument(yaml, { compat: ["timestamp"] });
    if (document.errors.length > 0) return undefined;
    const parsed = TriggerDocumentSchema.safeParse(document.toJS());
    return parsed.success ? describeTrigger(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}
