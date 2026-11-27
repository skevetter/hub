import { expect, it } from "vitest";
import type { CompiledHubConfig } from "../config/compiler.js";
import { linearRoutesForConnection } from "./linear-trigger-routes.js";

type Trigger = CompiledHubConfig["triggers"][number];

it("keeps only matching pinned routes and truly unfiltered Linear routes in input order", () => {
  const rows: Pick<Trigger, "name" | "on" | "filters">[] = [
    { name: "other", on: "slack.message", filters: {} },
    { name: "unfiltered", on: "linear.issue", filters: {} },
    { name: "slug", on: "linear.issue", filters: { connection: "slug" } },
    { name: "project", on: "linear.issue", filters: { project: "project" } },
    { name: "resource", on: "linear.issue", filters: { resourceId: "resource" } },
    { name: "mismatch", on: "linear.issue", filters: { connectionId: "other" } },
    {
      name: "pinned",
      on: "linear.issue",
      filters: { connectionId: "match", resourceId: "resource" },
    },
    { name: "missing", on: "linear.issue", filters: undefined },
  ];
  const triggers = rows.map(({ name, on, filters }) => ({
    maxRuntimeMs: 1,
    steps: [],
    inputs: {},
    values: {},
    name,
    on,
    filters,
  }));
  const routes = linearRoutesForConnection({ environments: [], triggers }, "match");
  expect(routes).toEqual([
    {
      provider: "linear",
      connectionId: "match",
      resourceId: null,
      triggerName: "unfiltered",
      configuredEventName: "linear.issue",
    },
    {
      provider: "linear",
      connectionId: "match",
      resourceId: "resource",
      triggerName: "pinned",
      configuredEventName: "linear.issue",
    },
    {
      provider: "linear",
      connectionId: "match",
      resourceId: null,
      triggerName: "missing",
      configuredEventName: "linear.issue",
    },
  ]);
  expect(routes.map(Object.keys)).toEqual(
    Array.from({ length: 3 }, () => [
      "provider",
      "connectionId",
      "resourceId",
      "triggerName",
      "configuredEventName",
    ]),
  );
});
