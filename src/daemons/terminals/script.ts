import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { DaemonResponseLostError } from "../protocol.js";
import { DaemonTerminalError, type TerminalCapture, type TerminalConnection } from "./index.js";

export const SCRIPT_PERMISSION_MESSAGE =
  "The daemon does not allow Hub to run scripts: run `paseo hub permissions grant workspace.write` and `paseo hub permissions grant workspace.read` on that host.";
export const TERMINAL_ENDED_MESSAGE = "terminal ended before reporting an exit code";

export const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const CAPTURE_LINES = 400;
const TERMINAL_SIZE = { rows: 50, cols: 240 };
/** How long the wrapper keeps the terminal alive after the script ends, so capture still works. */
const LINGER_SECONDS = 30;
const FAST_POLL_MS = 250;
const SLOW_POLL_MS = 1_000;
const FAST_POLL_WINDOW_MS = 10_000;

export interface ScriptRunInput {
  cwd: string;
  script: string;
  /** JSON for the script's HUB_EVENT_JSON variable. */
  eventJson: string;
  /** Names the terminal, so a lost create response can still be found and killed. */
  name: string;
  /** How long the script may run, counted from the start of the run on the runner's clock. */
  timeoutMs: number;
  /** Called once the terminal exists, before any polling, so the id can be made durable. */
  onTerminal?: (terminal: { id: string }) => Promise<void>;
  signal?: AbortSignal;
}

export interface ScriptRunResult {
  status: "succeeded" | "failed" | "timed_out";
  /** Null when no exit code was reported: a timeout, a vanished terminal, a refusal. */
  exitCode: number | null;
  outputTail: string;
  truncated: boolean;
  /** Set unless the script exited 0. */
  failureReason?: string;
}

export interface ScriptRunnerClock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  random(): string;
}

export const systemScriptRunnerClock: ScriptRunnerClock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    try {
      await delay(milliseconds, undefined, signal === undefined ? {} : { signal });
    } catch {
      // An abort ends the wait early; the caller checks the signal.
    }
  },
  random: randomUUID,
};

/**
 * The shell command that runs the script and prints its exit code. The script and the event are
 * argv elements `$1` and `$2`, never part of this string, so neither is parsed by the outer shell.
 * The trailing colon keeps a half-written marker from being read as a shorter exit code.
 */
export function scriptWrapper(markerId: string): string {
  return `HUB_EVENT_JSON="$2" /bin/sh -c "$1"; rc=$?; printf '\\n${marker(markerId)}%s:\\n' "$rc"; sleep ${String(LINGER_SECONDS)}`;
}

function marker(markerId: string): string {
  return `__HUB_EXIT_${markerId}__:`;
}

export function scriptTerminalCommand(markerId: string, script: string, eventJson: string) {
  return {
    command: "/bin/sh",
    args: ["-c", scriptWrapper(markerId), "sh", script, eventJson],
  };
}

export class ScriptRunAborted extends Error {
  constructor() {
    super("script run aborted");
    this.name = "ScriptRunAborted";
  }
}

/**
 * Runs a script in a daemon terminal and reports how it ended. It always asks the daemon to kill
 * the terminal it created, so nothing is left behind whatever the outcome.
 */
export async function runScript(
  terminals: TerminalConnection,
  input: ScriptRunInput,
  clock: ScriptRunnerClock = systemScriptRunnerClock,
): Promise<ScriptRunResult> {
  const deadlineAt = clock.now() + input.timeoutMs;
  const markerId = clock.random();
  const { command, args } = scriptTerminalCommand(markerId, input.script, input.eventJson);
  let terminalId: string | undefined;
  try {
    try {
      const terminal = await terminals.create({
        cwd: input.cwd,
        name: input.name,
        command,
        args,
        size: TERMINAL_SIZE,
      });
      terminalId = terminal.id;
      await input.onTerminal?.({ id: terminal.id });
    } catch (error) {
      if (error instanceof DaemonResponseLostError) await killByName(terminals, input);
      return refused(error, input.cwd);
    }
    return await poll(terminals, terminalId, markerId, deadlineAt, input, clock);
  } finally {
    if (terminalId !== undefined) await terminals.kill(terminalId).catch(() => undefined);
  }
}

/** Kills what a previous run left on the host, found by the id when known and else by name. */
export async function killScriptTerminal(
  terminals: TerminalConnection,
  target: { cwd: string; name: string; terminalId?: string | undefined },
): Promise<void> {
  if (target.terminalId !== undefined) {
    await terminals.kill(target.terminalId);
    return;
  }
  await killByName(terminals, target);
}

async function killByName(
  terminals: TerminalConnection,
  target: { cwd: string; name: string },
): Promise<void> {
  try {
    const found = await terminals.list(target.cwd);
    await Promise.all(
      found.filter(({ name }) => name === target.name).map(({ id }) => terminals.kill(id)),
    );
  } catch {
    // The caller already reports the original failure; there is nothing more it can do.
  }
}

async function poll(
  terminals: TerminalConnection,
  terminalId: string,
  markerId: string,
  deadlineAt: number,
  input: ScriptRunInput,
  clock: ScriptRunnerClock,
): Promise<ScriptRunResult> {
  const startedAt = clock.now();
  const exit = new RegExp(`^${marker(markerId)}(\\d{1,3}):$`, "u");
  let lastLines: readonly string[] = [];
  let lastTotal = 0;
  for (;;) {
    if (isAborted(input.signal)) throw new ScriptRunAborted();
    if (clock.now() >= deadlineAt) {
      const tail = await captureQuietly(terminals, terminalId, lastLines, lastTotal);
      return {
        ...tailOf(tail.lines, tail.total),
        status: "timed_out",
        exitCode: null,
        failureReason: "script timed out",
      };
    }
    const elapsed = clock.now() - startedAt;
    await clock.sleep(elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS, input.signal);
    if (isAborted(input.signal)) throw new ScriptRunAborted();
    const capture = await terminals
      .capture(terminalId, -CAPTURE_LINES)
      .catch((error: unknown) => error);
    if (!isCapture(capture)) {
      return { ...tailOf(lastLines, lastTotal), ...refusedFields(capture, input.cwd) };
    }
    const lines = capture.lines.map(stripAnsi);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = exit.exec(lines[index]!.trimEnd());
      if (match === null) continue;
      const exitCode = Number(match[1]);
      const tail = tailOf(lines.slice(0, index), capture.totalLines - (lines.length - index));
      return exitCode === 0
        ? { ...tail, status: "succeeded", exitCode }
        : {
            ...tail,
            status: "failed",
            exitCode,
            failureReason: `script exited ${String(exitCode)}`,
          };
    }
    if (lines.length > 0) {
      lastLines = lines;
      lastTotal = capture.totalLines;
      continue;
    }
    if (!(await stillListed(terminals, terminalId, input.cwd))) {
      return {
        ...tailOf(lastLines, lastTotal),
        status: "failed",
        exitCode: null,
        failureReason: TERMINAL_ENDED_MESSAGE,
      };
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isCapture(value: unknown): value is TerminalCapture {
  return typeof value === "object" && value !== null && "lines" in value && "totalLines" in value;
}

/** An empty capture means either no output yet or no terminal; the daemon's list tells which. */
async function stillListed(
  terminals: TerminalConnection,
  terminalId: string,
  cwd: string,
): Promise<boolean> {
  try {
    return (await terminals.list(cwd)).some(({ id }) => id === terminalId);
  } catch {
    return true;
  }
}

async function captureQuietly(
  terminals: TerminalConnection,
  terminalId: string,
  fallback: readonly string[],
  fallbackTotal: number,
): Promise<{ lines: readonly string[]; total: number }> {
  try {
    const capture = await terminals.capture(terminalId, -CAPTURE_LINES);
    if (capture.lines.length > 0)
      return { lines: capture.lines.map(stripAnsi), total: capture.totalLines };
  } catch {
    // The timeout is already the outcome; the last tail seen is good enough.
  }
  return { lines: fallback, total: fallbackTotal };
}

function refused(error: unknown, cwd: string): ScriptRunResult {
  return { outputTail: "", truncated: false, ...refusedFields(error, cwd) };
}

function refusedFields(
  error: unknown,
  cwd: string,
): Pick<ScriptRunResult, "status" | "exitCode" | "failureReason"> {
  return { status: "failed", exitCode: null, failureReason: refusalMessage(error, cwd) };
}

export function refusalMessage(error: unknown, cwd: string): string {
  if (error instanceof DaemonTerminalError) {
    if (error.code === "permission_denied") return SCRIPT_PERMISSION_MESSAGE;
    if (error.code === "no_workspace")
      return `Open ${cwd} as a project in Paseo on that host, then retry.`;
    return `The daemon refused the script terminal: ${error.message}`;
  }
  if (error instanceof DaemonResponseLostError)
    return "The daemon did not answer the terminal request.";
  return `The script terminal failed: ${error instanceof Error ? error.message : String(error)}`;
}

function stripAnsi(line: string): string {
  return stripVTControlCharacters(line);
}

/** The last 64 KB of the lines, whole lines dropped from the front, and whether anything was cut. */
function tailOf(
  lines: readonly string[],
  totalLines: number,
): Pick<ScriptRunResult, "outputTail" | "truncated"> {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
  let text = trimmed.join("\n");
  let truncated = totalLines > lines.length;
  if (Buffer.byteLength(text) > MAX_OUTPUT_TAIL_BYTES) {
    let bytes = Buffer.from(text).subarray(-MAX_OUTPUT_TAIL_BYTES);
    // Drop a partial multi-byte character at the cut.
    while (bytes.length > 0 && (bytes[0]! & 0xc0) === 0x80) bytes = bytes.subarray(1);
    text = bytes.toString();
    truncated = true;
  }
  return { outputTail: text, truncated };
}

/** What the workflow engine needs to run a script step and to clean up after one that was lost. */
export interface ScriptStepRunner {
  run(daemonId: string, input: ScriptRunInput): Promise<ScriptRunResult>;
  cleanup(
    daemonId: string,
    target: { cwd: string; name: string; terminalId?: string | undefined },
  ): Promise<void>;
}

export function createScriptStepRunner(
  connectionForDaemon: (daemonId: string) => { terminals?: TerminalConnection } | undefined,
  clock: ScriptRunnerClock = systemScriptRunnerClock,
): ScriptStepRunner {
  return {
    async run(daemonId, input) {
      const terminals = connectionForDaemon(daemonId)?.terminals;
      if (terminals === undefined) {
        return {
          status: "failed",
          exitCode: null,
          outputTail: "",
          truncated: false,
          failureReason: "The daemon is not connected to this Hub, so it cannot run the script.",
        };
      }
      return runScript(terminals, input, clock);
    },
    async cleanup(daemonId, target) {
      const terminals = connectionForDaemon(daemonId)?.terminals;
      if (terminals === undefined) throw new Error("daemon_not_connected");
      await killScriptTerminal(terminals, target);
    },
  };
}
