import { isAlias, isMap, isNode, parseDocument, visit, type Document, type Node } from "yaml";

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

type Literal = (path: readonly string[]) => boolean;

export function describeTrigger(document: TriggerDocument, literal: Literal = () => true): string {
  const eligible: string[] = [];
  const blocked: string[] = [];
  for (const [event, definition] of Object.entries(document.on)) {
    const path = ["on", event];
    if (!literal(path)) {
      eligible.push("When a configured event arrives");
      continue;
    }
    const filterPath = [...path, "filters"];
    const entries = Object.entries(definition.filters ?? {});
    const direct = entries.filter(([key]) => literal([...filterPath, key]));
    const filters: Filters = Object.fromEntries(direct);
    const reason = blockedReason(event, definition.filters ?? {});
    if (reason !== undefined) {
      blocked.push(reason);
      continue;
    }
    if (event === "schedule.tick" && definition.recurrence !== undefined) {
      eligible.push(describeSchedule(definition.recurrence, literal([...path, "recurrence"])));
      continue;
    }
    const opaque = direct.length < entries.length ? " with additional configured filters" : "";
    eligible.push(
      `When ${triggerEventClause(event)}${describeFilters(event, filters, Boolean(definition.filters?.pattern))}${opaque}`,
    );
  }
  if (eligible.length === 0) return `${joinClauses(blocked)}.`;
  const run = document.run;
  const host = literal(["run", "target", "daemon"])
    ? `host ${run.target.daemon}`
    : "the configured host";
  const action = describeAction(run, literal);
  const excluded = blocked.length === 0 ? "" : `, while ${lowerFirst(joinClauses(blocked))}`;
  return `${joinClauses(eligible)}, run ${action} on ${host}${excluded}.`;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function joinClauses(clauses: string[]): string {
  return alternatives.format(
    clauses.map((clause, index) => (index === 0 ? clause : lowerFirst(clause))),
  );
}

function describeSchedule(
  recurrence: NonNullable<TriggerDocument["on"][string]["recurrence"]>,
  literal: boolean,
): string {
  if (!literal) return "On the configured schedule";
  const schedule = recurrenceSummary(recurrence);
  return schedule.startsWith("Every")
    ? schedule
    : `On the configured schedule in ${recurrence.timezone}`;
}

function describeAction(run: TriggerDocument["run"], literal: Literal): string {
  if (isScriptRun(run)) return "a script";
  if ("choices" in run.agent || !literal(["run", "agent", "provider"])) return "the selected agent";
  const { provider, model } = run.agent;
  if (model === undefined || !literal(["run", "agent", "model"])) return provider;
  return `${provider}/${model}`;
}

function blockedReason(event: string, filters: NonNullable<Filters>): string | undefined {
  if (event === "manual.run" && filters.from_users?.length === 0) {
    return "For manual and webhook requests, no callers can run this trigger";
  }
  if (filters.channels?.length === 0) {
    if (event === "slack.mention") return "For Slack mentions, no channels can match";
    if (event === "discord.mention") return "For Discord mentions, no channels can match";
  }
  if (event === "github.push" && filters.from_users && !filters.from_users.includes("*")) {
    return "A named sender filter cannot match because push events carry no sender";
  }
  return undefined;
}

type Filters = TriggerDocument["on"][string]["filters"];

function describeFilters(event: string, filters: Filters, hasPattern: boolean): string {
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
    if (prefixCommand && qualifier.key === "contains" && hasPattern) continue;
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
    if (!parsed.success) return undefined;
    const targets = collectAliasTargets(document);
    return describeTrigger(parsed.data, (path) => isLiteralAt(document, path, targets));
  } catch {
    return undefined;
  }
}

function collectAliasTargets(document: Document): Set<Node> {
  const targets = new Set<Node>();
  visit(document, {
    Alias(_key, alias) {
      const target = alias.resolve(document);
      if (target !== undefined) targets.add(target);
    },
  });
  return targets;
}

function isLiteralAt(
  document: Document,
  path: readonly string[],
  aliasTargets: Set<Node>,
): boolean {
  let node: unknown = document.contents;
  for (const key of path) {
    if (!isMap(node) || aliasTargets.has(node) || node.items.some((pair) => isAlias(pair.key))) {
      return false;
    }
    node = node.get(key, true);
  }
  if (!isNode(node)) return false;
  // Event names are safe when the authored mapping key is literal, even if the rule is opaque.
  if (path.length === 2 && path[0] === "on") return true;
  let literal = true;
  visit(node, (_key, value) => {
    if (isNode(value) && (isAlias(value) || aliasTargets.has(value))) {
      literal = false;
      return visit.BREAK;
    }
    return undefined;
  });
  return literal;
}
