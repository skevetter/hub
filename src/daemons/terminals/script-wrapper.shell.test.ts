import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { scriptTerminalCommand } from "./script.js";

const MARKER = "11111111-2222-4333-8444-555555555555";
const sandbox = mkdtempSync(join(tmpdir(), "hub-wrapper-"));

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

/** Runs the exact command Hub gives the daemon, in a real /bin/sh with no linger. */
function runWrapper(script: string, eventJson = "{}") {
  const { command, args } = scriptTerminalCommand(MARKER, script, eventJson, 0);
  return new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: sandbox, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });
}

const marker = (code: number) => `\n__HUB_EXIT_${MARKER}__:${String(code)}:\n`;

describe("the wrapper in a real /bin/sh", () => {
  test.each([
    ["true", 0],
    ["exit 7", 7],
    ["definitely-not-a-command-hub", 127],
  ])("reports the exit code of `%s` as %i on its own marker line", async (script, code) => {
    const result = await runWrapper(script);
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith(marker(code))).toBe(true);
  });

  test("puts the marker on its own line when the script prints no trailing newline", async () => {
    const result = await runWrapper("printf abc");
    expect(result.stdout).toBe(`abc${marker(0)}`);
  });

  test("a script that starts with a dash is a command, not a shell option", async () => {
    const result = await runWrapper("-x");
    expect(result.stdout.endsWith(marker(127))).toBe(true);
    expect(result.stdout).not.toContain("requires an argument");
    const traced = await runWrapper("-x\ntrue");
    expect(traced.stdout).toContain("not found");
  });

  test("the event reaches the script byte for byte and is never run as code", async () => {
    const sentinel = join(sandbox, "pwned");
    const event = JSON.stringify({
      title: `'; touch ${sentinel}; echo '`,
      body: `$(touch ${sentinel}) \`touch ${sentinel}\` "quoted" 'single' \\ end`,
    });
    const result = await runWrapper('printf %s "$HUB_EVENT_JSON"', event);
    expect(result.stdout).toBe(`${event}${marker(0)}`);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("script text full of quotes and substitutions runs as written, not through the outer shell", async () => {
    const sentinel = join(sandbox, "outer");
    const script = `echo "$(echo nested)" 'it'"'"'s'; echo '$(touch ${sentinel})'`;
    const result = await runWrapper(script);
    expect(result.stdout).toBe(`nested it's\n$(touch ${sentinel})\n${marker(0)}`);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("the script keeps its own environment variable and sees nothing of the wrapper's", async () => {
    const result = await runWrapper('printf "%s|%s" "${rc-unset}" "${1-unset}"');
    expect(result.stdout).toBe(`unset|unset${marker(0)}`);
  });
});
