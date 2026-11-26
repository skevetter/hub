import { expect, it } from "vitest";
import { TriggerDocumentSchema, TriggerInputSchema } from "./schema.js";

it("reports an empty event map before an empty agent choice map", () => {
  const result = TriggerDocumentSchema.safeParse({
    name: "example",
    on: {},
    run: {
      target: { daemon: "dev", cwd: "/workspace" },
      agent: { select: "agent", choices: {} },
      prompt: "Run",
    },
  });
  expect(result.error?.issues).toEqual([
    { code: "custom", path: ["on"], message: "at least one event is required" },
    {
      code: "custom",
      path: ["run", "agent", "choices"],
      message: "at least one agent choice is required",
    },
  ]);
});

it.each([
  [Number.MAX_VALUE, true],
  [0, true],
  [Infinity, false],
  [-Infinity, false],
  [NaN, false],
])("validates a numeric default of %s", (value, accepted) => {
  expect(TriggerInputSchema.safeParse({ type: "number", default: value }).success).toBe(accepted);
});

it.each([Infinity, -Infinity, NaN])("rejects non-finite numeric choice %s", (value) => {
  const result = TriggerInputSchema.safeParse({ type: "number", choices: [0, value] });
  expect(result.error?.issues.map((issue) => issue.path)).toEqual([["choices", 1]]);
});
