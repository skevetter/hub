import {
  isAlias,
  isMap,
  isNode,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type Node,
} from "yaml";

import { recurrenceSummary } from "../schedule/recurrence.js";
import { eventDefinition, isEditorEvent, type QualifierDefinition } from "./events.js";
import {
  isScriptStep,
  TriggerDocumentSchema,
  type TriggerDocument,
  type TriggerStep,
} from "./schema.js";
import { normalizeSteps } from "./steps.js";

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

type Literal = (path: readonly (string | number)[]) => boolean;

export function describeTrigger(document: TriggerDocument, literal: Literal = () => true): string {
  const eligible: string[] = [];
  const blocked: string[] = [];
  for (const [event, definition] of Object.entries(document.on)) {
    const clause = describeEvent(event, definition, literal);
    (clause.blocked ? blocked : eligible).push(clause.text);
  }
  if (eligible.length === 0) return `${joinClauses(blocked)}.`;
  const { target, steps, shorthand } = normalizeSteps(document);
  const host = literal([...(shorthand ? ["run"] : []), "target", "daemon"])
    ? `host ${target.daemon}`
    : "the configured host";
  const action = describeSteps(steps, literal, shorthand);
  const excluded = blocked.length === 0 ? "" : `, while ${lowerFirst(joinClauses(blocked))}`;
  const reply =
    document.reply_message === true && literal(["reply_message"])
      ? " Post the agent's final reply on the source Linear issue after a successful run."
      : "";
  return `${joinClauses(eligible)}, run ${action} on ${host}${excluded}.${reply}`;
}

function describeEvent(
  event: string,
  definition: TriggerDocument["on"][string],
  literal: Literal,
): { blocked: boolean; text: string } {
  const path = ["on", event];
  if (!literal(path)) return { blocked: false, text: "When a configured event arrives" };

  const filterPath = [...path, "filters"];
  const entries = Object.entries(definition.filters ?? {});
  const direct = entries.filter(([key]) => literal([...filterPath, key]));
  const filters: Filters = Object.fromEntries(direct);
  const reason = blockedReason(event, definition.filters ?? {});
  if (reason !== undefined) return { blocked: true, text: reason };

  const text =
    event === "schedule.tick" && definition.recurrence !== undefined
      ? describeSchedule(definition.recurrence, literal([...path, "recurrence"]))
      : describeEventClause(event, definition, filters, direct.length < entries.length);
  return { blocked: false, text };
}

function describeEventClause(
  event: string,
  definition: TriggerDocument["on"][string],
  filters: Filters,
  opaque: boolean,
): string {
  const suffix = opaque ? " with additional configured filters" : "";
  return `When ${triggerEventClause(event)}${describeFilters(event, filters, Boolean(definition.filters?.pattern))}${suffix}`;
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

function describeSteps(
  steps: readonly TriggerStep[],
  literal: Literal,
  shorthand: boolean,
): string {
  const [only] = steps;
  if (steps.length === 1 && only !== undefined) {
    return describeAction(only, literal, shorthand ? ["run"] : ["steps", 0]);
  }
  const names = steps.map((step, index) =>
    literal(["steps", index, "id"]) ? step.id : `step ${String(index + 1)}`,
  );
  return `${String(steps.length)} steps (${together.format(names)})`;
}

function describeAction(
  step: TriggerStep,
  literal: Literal,
  path: readonly (string | number)[],
): string {
  if (isScriptStep(step)) return "a script";
  if ("choices" in step.agent || !literal([...path, "agent", "provider"])) {
    return "the selected agent";
  }
  const { provider, model } = step.agent;
  if (model === undefined || !literal([...path, "agent", "model"])) return provider;
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
  return blockedPushReason(event, filters);
}

function blockedPushReason(event: string, filters: NonNullable<Filters>): string | undefined {
  return event === "github.push" && filters.from_users && !filters.from_users.includes("*")
    ? "A named sender filter cannot match because push events carry no sender"
    : undefined;
}

type Filters = TriggerDocument["on"][string]["filters"];

function describeFilters(event: string, filters: Filters, hasPattern: boolean): string {
  if (filters === undefined || !isEditorEvent(event)) return "";
  const definition = eventDefinition(event);
  const prefixCommand = definition.provider === "slack" || definition.provider === "discord";
  const names = filters.from_users ?? [];
  const clauses = [];
  const audience = describeAudience(definition, names);
  if (audience !== undefined) clauses.push(audience);
  for (const qualifier of definition.qualifiers) {
    const clause = describeFilter(qualifier, filters, prefixCommand, hasPattern);
    if (clause !== undefined) clauses.push(clause);
  }
  return clauses.length === 0 ? "" : ` ${clauses.join(" ")}`;
}

function describeFilter(
  qualifier: QualifierDefinition,
  filters: NonNullable<Filters>,
  prefixCommand: boolean,
  hasPattern: boolean,
): string | undefined {
  if (prefixCommand && qualifier.key === "contains" && hasPattern) return undefined;
  return describeQualifier(qualifier, filters[qualifier.key], prefixCommand);
}

function describeAudience(
  definition: ReturnType<typeof eventDefinition>,
  names: string[],
): string | undefined {
  return definition.audience !== "none" &&
    names.length > 0 &&
    !(definition.audience === "wildcard" && names.includes("*"))
    ? `from ${alternatives.format(names)}`
    : undefined;
}

function describeQualifier(
  { key, label }: QualifierDefinition,
  value: NonNullable<Filters>[QualifierDefinition["key"]],
  prefixCommand: boolean,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const name = label.toLowerCase();
  if (typeof value === "string") {
    return describeTextQualifier({ key, name, value, prefixCommand });
  }
  if (Array.isArray(value)) {
    return describeListQualifier(key, name, value);
  }
  return Object.keys(value).length === 0 ? undefined : "with matching inputs";
}

function describeTextQualifier({
  key,
  name,
  value,
  prefixCommand,
}: {
  key: QualifierDefinition["key"];
  name: string;
  value: string;
  prefixCommand: boolean;
}): string {
  if (key === "repo" || key === "project") return `in ${name} ${value}`;
  const match = key === "pattern" || key === "contains";
  if (prefixCommand && match) return `with command prefix ${JSON.stringify(value)}`;
  const prefix = match || key === "exclude_contains" ? "and the" : "with";
  return `${prefix} ${name} ${JSON.stringify(value)}`;
}

function describeListQualifier(
  key: QualifierDefinition["key"],
  name: string,
  value: string[],
): string | undefined {
  if (value.length === 0) return undefined;
  const format = key === "labels" ? together : alternatives;
  const prefix = key === "exclude_labels" ? "without labels" : `with ${name}`;
  return `${prefix} ${format.format(value)}`;
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

function childNode(node: unknown, key: string | number, aliasTargets: Set<Node>): unknown {
  if (isSeq(node)) return aliasTargets.has(node) ? undefined : node.get(key, true);
  if (!isMap(node) || aliasTargets.has(node) || node.items.some((pair) => isAlias(pair.key))) {
    return undefined;
  }
  return node.get(key, true);
}

function isLiteralAt(
  document: Document,
  path: readonly (string | number)[],
  aliasTargets: Set<Node>,
): boolean {
  let node: unknown = document.contents;
  for (const key of path) node = childNode(node, key, aliasTargets);
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
