import { describe, expect, it } from "vitest";
import { compileHubBundle, HubBundleError, type HubBundleFile } from "./bundle.js";

const hub = ".paseo/hub.yml";
const workflow = ".paseo/workflows/run.yml";
const partial = ".paseo/workflows/partials/guide.md";
const resource = `name: demo
environments:
  local: { kind: daemon, daemon: local, cwd: /repo }
agents:
  codex: { provider: codex }
`;
const trigger = `name: run
on: manual.run
max_runtime: 1h
steps:
  - id: work
    environment: local
    max_runtime: 10m
    idle_timeout: 1m
    agent: codex
    prompt:
      - include: partials/guide.md
`;

function fixture(): HubBundleFile[] {
  return [
    { path: workflow, content: trigger },
    { path: partial, content: "instructions" },
    { path: hub, content: resource },
  ];
}

function issues(files: readonly HubBundleFile[]) {
  try {
    compileHubBundle(files);
    return [];
  } catch (error) {
    if (!(error instanceof HubBundleError)) throw error;
    return error.issues;
  }
}

describe("Hub bundle compilation characterization", () => {
  it("keeps authored files in canonical order and records validation targets", () => {
    const files = fixture();
    const compiled = compileHubBundle(files);
    expect(compiled.name).toBe("demo");
    expect(compiled.files).toEqual(files.toSorted((a, b) => a.path.localeCompare(b.path)));
    expect(compiled.authoredHash).toBe(compileHubBundle(files.toReversed()).authoredHash);
    expect(compiled.agentValidationTargets).toEqual([
      { name: "codex", agent: { provider: "codex" }, environmentNames: ["local"] },
    ]);
  });

  it("validates paths before parsing and duplicate workflow names before resolving partials", () => {
    expect(issues([{ path: ".paseo/workflows/else/nested.yml", content: "" }])).toEqual([
      {
        path: [".paseo/workflows/else/nested.yml"],
        message: "workflow YAML must be a direct child of .paseo/workflows/",
      },
    ]);
    const duplicate = ".paseo/workflows/second.yml";
    expect(issues([...fixture(), { path: duplicate, content: trigger }])).toEqual([
      { path: [duplicate, "name"], message: `workflow name run is already defined in ${workflow}` },
    ]);
  });

  it("reports missing and unused partials at their authored paths", () => {
    expect(issues(fixture().filter(({ path }) => path !== partial))).toEqual([
      { path: [partial], message: "prompt partial is missing from the bundle" },
    ]);
    const unused = ".paseo/workflows/partials/unused.md";
    expect(issues([...fixture(), { path: unused, content: "" }])).toEqual([
      { path: [unused], message: "partial file is not referenced by any workflow" },
    ]);
  });

  it("reports compiled step and environment issues using authored names", () => {
    expect(
      issues(
        fixture().map((file) =>
          file.path === workflow
            ? {
                path: file.path,
                content: trigger.replace("idle_timeout: 1m", "idle_timeout: false"),
              }
            : file,
        ),
      ).map(({ path }) => path),
    ).toEqual([[workflow, "steps", "work", "idle_timeout"]]);
    expect(
      issues(
        fixture().map((file) =>
          file.path === hub
            ? { path: file.path, content: resource.replace("cwd: /repo", "cwd: false") }
            : file,
        ),
      ).map(({ path }) => path),
    ).toEqual([[hub, "environments", "local", "cwd"]]);
  });
});
