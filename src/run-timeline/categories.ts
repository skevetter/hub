import { isHubFinishExecutionToolName } from "../hub/protocol.js";

export const TOOL_CATEGORIES = [
  "command",
  "read",
  "edit",
  "web",
  "subagent",
  "plan",
  "mcp",
  "finish",
  "other",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

const CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  Bash: "command",
  shell: "command",
  Read: "read",
  Glob: "read",
  Grep: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  apply_patch: "edit",
  WebFetch: "web",
  WebSearch: "web",
  Agent: "subagent",
  Task: "subagent",
  TodoWrite: "plan",
};

export function toolCategory(name: string): ToolCategory {
  if (isHubFinishExecutionToolName(name)) return "finish";
  if (Object.hasOwn(CATEGORIES, name)) {
    const category = CATEGORIES[name];
    if (category === undefined)
      throw new Error("timeline categories invariant: expected a category for an own name");
    return category;
  }
  if (name.startsWith("mcp__") || name.startsWith("mcp.") || name.includes(" / ")) return "mcp";
  return "other";
}
