import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { createToolStepRenderer } from "./tool-steps-content.js";

const scrub = createTimelineScrubber({ scrubValues: ["fixture-abcdefghij"] });
const render = createToolStepRenderer(scrub, "/w/app");
const base = { name: "mcp__host__inspect", status: "completed" };

it.each([
  [{ type: "shell", command: "git status --porcelain", exitCode: 0 }, "Ran command", "git status"],
  [{ type: "read", filePath: "src/note.ts", content: "not posted" }, "Read", "src/note.ts"],
  [{ type: "write", filePath: "one", content: "not posted" }, "Wrote", "one"],
  [{ type: "edit", filePath: "two", diffs: ["not posted"] }, "Edited", "two"],
  [{ type: "search", toolName: "rg", query: "https://example.com/private" }, "Searched", "query"],
  [
    { type: "fetch", url: "https://example.com/one/two/three?a=b#c" },
    "Fetched",
    "example.com/one/two",
  ],
  [{ type: "sub_agent", input: "not posted" }, "Started sub-agent", "sub-agent"],
  [{ type: "unknown", input: "not posted", output: "not posted" }, "Called tool", "inspect"],
  [{ type: "mcp", input: "not posted" }, "Called tool", "inspect"],
  [{ type: "read" }, "Used tool", base.name],
  [{ type: "read", filePath: 42 }, "Used tool", base.name],
  [undefined, "Used tool", base.name],
])("maps detail %j and emits only the allowlisted fields", (detail, action, parameter) => {
  const result = detail?.type === "shell" ? { result: "exit 0" } : {};
  expect(render({ ...base, detail })).toEqual({ type: "action", action, parameter, ...result });
});

it("does not use fields inherited from the detail prototype", () => {
  const detail: unknown = Object.setPrototypeOf({ type: "read" }, { filePath: "private" });
  expect(render({ ...base, detail })).toMatchObject({ action: "Used tool", parameter: base.name });
});

it.each([
  ["curl -u user:pw", "command"],
  ["mysql -pHunter2", "command"],
  ["ADMIN=hunter2 ./run", "command"],
  ['bash -lc "git status"', "git status"],
  ["sh -c 'git diff'", "git diff"],
  ["zsh -lc 'git log || false'", "git"],
  ["/usr/bin/git status && curl x", "git"],
  ["git status\ncurl x", "git"],
  ["git status\rcurl x", "git"],
  ["bash -lc 'git status\ncurl x'", "git"],
  ["grep hunter", "grep"],
  ["rg acmecorp", "rg"],
  ["git 'unclosed", "command"],
  ["git status > private", "git"],
  ["N='one two' /usr/bin/npm run workspace", "npm run"],
])("reshapes shell %j to %j", (command, parameter) => {
  expect(render({ ...base, detail: { type: "shell", command, output: "not posted" } })).toEqual({
    type: "action",
    action: "Ran command",
    parameter,
  });
});

it.each([
  ["file:///private/one", "[hidden]"],
  ["data:text/plain,one", "[hidden]"],
  ["https://example.com/one/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "example.com/one/*"],
  ["https://example.com/abcdefabcdefabcd", "example.com/*"],
  ["http://127.0.0.1", "[hidden]"],
  ["http://2130706433", "[hidden]"],
  ["http://[::1]", "[hidden]"],
  ["http://workstation/path", "[hidden]"],
  ["https://example.local/one", "[hidden]"],
  ["https://room12abc.example.com/one", "[hidden]"],
  ["https://abcdefghijklmnopqrst.example.com/one", "[hidden]"],
  ["https://user%40mail:pw@example.com.:444/a%2Fb/c%40d/more?q=drop#drop", "example.com/*/*"],
])("reshapes URL %j to %j", (url, parameter) => {
  expect(render({ ...base, detail: { type: "fetch", url } }).parameter).toBe(parameter);
});

it.each([
  ["../one", "outside workspace"],
  ["/w/app-evil/one", "outside workspace"],
  ["C:\\Users\\x\\f", "outside workspace"],
  ["file:/w/app/one", "outside workspace"],
  ["x\\one", "outside workspace"],
  ["top/.ssh/a/b/c/d/e", "[hidden]"],
  [".env.production", "[hidden]"],
  ["~/.ssh/id_ed25519", "outside workspace"],
  ["a/b/c/d/e/f", ".../c/d/e/f"],
  ["/W/App/Docs/New.md", "Docs/New.md"],
  ["a/s\u200bk-demo", "[hidden]"],
  ["s[k]-example", "[hidden]"],
  ["paper`[notes]!(page)|", "paper'notes(page)"],
  ["%5Bmemo%5D.md", "memo.md"],
  ["%2Fprivate%2Fone", "outside workspace"],
  ["&#x66;ile.txt", "file.txt"],
  ["x".repeat(194) + "fixture-abcdefghij", "[hidden]"],
  ["x".repeat(3000), "[hidden]"],
  ["x".repeat(201), "[hidden]"],
])("cleans path %j to %j", (filePath, parameter) => {
  expect(render({ ...base, detail: { type: "read", filePath } }).parameter).toBe(parameter);
});

it("treats paths as outside workspace without a cwd", () => {
  const outside = createToolStepRenderer(scrub, undefined);
  expect(outside({ ...base, detail: { type: "read", filePath: "one" } }).parameter).toBe(
    "outside workspace",
  );
});

it.each([
  ["failed", 255, { result: "exit 255" }],
  ["canceled", "7", {}],
  ["completed", -1, {}],
  ["completed", 256, {}],
  ["completed", 1.5, {}],
])("reports shell status %s and only valid exit codes", (status, exitCode, result) => {
  const action = status === "completed" ? "Ran command" : `Ran command (${status})`;
  expect(
    render({ ...base, status, detail: { type: "shell", command: "git status", exitCode } }),
  ).toEqual({ type: "action", action, parameter: "git status", ...result });
});

it("keeps the private sensitive-label pattern in sync with the pinned scrubber", () => {
  const declaration =
    "const SENSITIVE_LABEL = /pass|pwd|secret|token|key|auth|basic|bearer|cred|session|cookie|sig/iu;";
  const pinned = readFileSync(new URL("../run-timeline/scrub.ts", import.meta.url), "utf8");
  const copy = readFileSync(new URL("./tool-steps-content.ts", import.meta.url), "utf8");
  expect(pinned).toContain(declaration);
  expect(copy).toContain(declaration);
});
