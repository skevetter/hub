import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isSeq,
  visit,
  type Alias,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

export type YamlPath = readonly (string | number)[];

export const SHARED_YAML_FIELD =
  "This field is shared with another field through a YAML anchor. Edit it in YAML.";

export function assertDocument(document: Document): void {
  const [error] = document.errors;
  if (error !== undefined) throw new Error(error.message);
}

function updateSequence(document: Document, sequence: YAMLSeq, values: readonly unknown[]): void {
  const oldItems = new Map<unknown, unknown[]>();
  for (const item of sequence.items) {
    const value: unknown = isNode(item) ? item.toJS(document) : item;
    const matches = oldItems.get(value) ?? [];
    matches.push(item);
    oldItems.set(value, matches);
  }
  const aliases = yamlAliases(document);
  sequence.items = values.map(
    (value) => oldItems.get(value)?.shift() ?? document.createNode(value),
  );
  restoreSequenceAliases(document, aliases);
}

export function yamlAliases(document: Document): Map<Alias, Node> {
  const aliases = new Map<Alias, Node>();
  visit(document, {
    Alias(_key, alias) {
      const target = alias.resolve(document);
      if (target !== undefined) aliases.set(alias, target);
    },
  });
  return aliases;
}

export function yamlAliasTargetsChanged(document: Document, before: Map<Alias, Node>): boolean {
  let changed = false;
  visit(document, {
    Alias(_key, alias) {
      if (alias.resolve(document) === before.get(alias)) return undefined;
      changed = true;
      return visit.BREAK;
    },
  });
  return changed;
}

export function sharedYamlPath(
  document: Document,
  path: YamlPath,
  aliases: Map<Alias, Node>,
  includeDescendants = true,
): boolean {
  if (aliases.size === 0) return false;
  let node: unknown = document.contents;
  for (const key of path) {
    if (isAlias(node)) return true;
    if (!isMap(node) && !isSeq(node)) return false;
    if (hasExternalReference(node, aliases, false)) return true;
    node = node.get(key, true);
  }
  return isNode(node) && leafIsShared(node, aliases, includeDescendants);
}

function leafIsShared(node: Node, aliases: Map<Alias, Node>, includeDescendants: boolean): boolean {
  if (isAlias(node) && !includeDescendants) return true;
  return hasExternalReference(node, aliases, includeDescendants);
}

function hasExternalReference(
  node: Node,
  aliases: Map<Alias, Node>,
  includeDescendants: boolean,
): boolean {
  for (const [alias, target] of aliases) {
    if (
      (target === node || (includeDescendants && yamlContains(node, target))) &&
      !yamlContains(node, alias)
    ) {
      return true;
    }
  }
  return false;
}

function yamlContains(parent: Node, child: Node): boolean {
  if (parent === child) return true;
  return (
    parent.range != null &&
    child.range != null &&
    parent.range[0] <= child.range[0] &&
    child.range[2] <= parent.range[2]
  );
}

export function requireWritableYaml(document: Document, path: YamlPath): void {
  if (sharedYamlPath(document, path, yamlAliases(document))) throw new Error(SHARED_YAML_FIELD);
}

export function restoreSequenceAliases(document: Document, aliases: Map<Alias, Node>): void {
  // Promote the first surviving alias if a list edit removed its anchor.
  visit(document, {
    Alias(_key, alias) {
      return alias.resolve(document) === undefined ? aliases.get(alias) : undefined;
    },
  });
}

export function setIfChanged(document: Document, path: YamlPath, value: unknown): void {
  const node = document.getIn(path, true);
  const current: unknown = isNode(node) ? node.toJS(document) : node;
  if (sameValue(current, value)) return;
  requireWritableYaml(document, path);
  if (isSeq(node) && Array.isArray(value)) {
    updateSequence(document, node, value);
    return;
  }
  const replacement =
    isAlias(node) || isCollection(node) ? replacementNode(document, node, value) : value;
  document.setIn(path, replacement);
}

function replacementNode(document: Document, node: Alias | YAMLMap | YAMLSeq, value: unknown) {
  // Write at the alias site so a field edit cannot change the value at its anchor.
  const replacement = document.createNode(value);
  if (node.comment !== undefined) replacement.comment = node.comment;
  if (node.commentBefore !== undefined) replacement.commentBefore = node.commentBefore;
  if (node.spaceBefore !== undefined) replacement.spaceBefore = node.spaceBefore;
  if (isCollection(node) && isCollection(replacement) && node.flow !== undefined)
    replacement.flow = node.flow;
  return replacement;
}

export function setOptional(document: Document, path: YamlPath, value: unknown): void {
  if (value === undefined) deleteIfPresent(document, path);
  else setIfChanged(document, path, value);
}

export function deleteIfPresent(document: Document, path: YamlPath): void {
  if (!document.hasIn(path)) return;
  requireWritableYaml(document, path);
  document.deleteIn(path);
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
