import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { retryWithBackoff, type BackoffPolicy, type RetryRuntime } from "../../db/retry.js";
import { SCRIPT_TERMINAL_PREFIX } from "../../workflows/script-output.js";
import { DaemonResponseLostError } from "../protocol.js";
import {
  DaemonTerminalError,
  type TerminalCapture,
  type TerminalConnection,
  type TerminalInfo,
} from "./index.js";

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
/** A silent script is told from a vanished terminal this often, not on every empty poll. */
const LIVENESS_INTERVAL_MS = 2_000;
/** Stopping a terminal is retried this long before the leftover is left to the sweep. */
const KILL_BACKOFF: BackoffPolicy = { baseMs: 250, factor: 2, capMs: 5_000, maxAttempts: 5 };

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
  /** Set when the daemon never confirmed the terminal stopped, so a sweep has to finish the job. */
  cleanup?: ScriptCleanupTarget;
}

export interface ScriptCleanupTarget {
  cwd: string;
  name: string;
  /** Absent when the terminal was never seen, for instance after a lost create response. */
  terminalId?: string | undefined;
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
 * `--` keeps a script that starts with a dash from being read as a shell option. The trailing
 * colon keeps a half-written marker from being read as a shorter exit code.
 */
export function scriptWrapper(markerId: string, lingerSeconds = LINGER_SECONDS): string {
  return `HUB_EVENT_JSON="$2" /bin/sh -c -- "$1"; rc=$?; printf '\\n${marker(markerId)}%s:\\n' "$rc"; sleep ${String(lingerSeconds)}`;
}

function marker(markerId: string): string {
  return `__HUB_EXIT_${markerId}__:`;
}

export function scriptTerminalCommand(
  markerId: string,
  script: string,
  eventJson: string,
  lingerSeconds = LINGER_SECONDS,
) {
  return {
    command: "/bin/sh",
    args: ["-c", scriptWrapper(markerId, lingerSeconds), "sh", script, eventJson],
  };
}

export class ScriptRunAborted extends Error {
  constructor() {
    super("script run aborted");
    this.name = "ScriptRunAborted";
  }
}

/**
 * Runs a script in a daemon terminal and reports how it ended. It asks the daemon to stop the
 * terminal it created, retrying with backoff, and a stop the daemon never confirms comes back as
 * `cleanup` so the caller can record it for a sweep. That is the guarantee: an unconfirmed stop is
 * always reported, never silent.
 */
export async function runScript(
  terminals: TerminalConnection,
  input: ScriptRunInput,
  clock: ScriptRunnerClock = systemScriptRunnerClock,
  retry: RetryRuntime = {},
): Promise<ScriptRunResult> {
  const deadlineAt = clock.now() + input.timeoutMs;
  const markerId = clock.random();
  const { command, args } = scriptTerminalCommand(markerId, input.script, input.eventJson);
  const created: { id?: string; workspaceId?: string; lostCreate?: boolean } = {};
  let outcome: ScriptRunResult | undefined;
  let thrown: unknown;
  try {
    outcome = await execute();
  } catch (error) {
    thrown = error;
  }
  const target: ScriptCleanupTarget = { cwd: input.cwd, name: input.name, terminalId: created.id };
  // A shutdown leaves the step running, and recovery stops the terminal: one attempt is enough.
  const attempts = isAborted(input.signal) ? 1 : undefined;
  const stopped =
    created.id !== undefined
      ? await stopTerminal(terminals, created.id, scopeOf(), clock, retry, attempts)
      : created.lostCreate !== true ||
        (await stopByName(terminals, target, clock, retry, attempts));
  if (thrown !== undefined) throw thrown;
  const result = outcome ?? refused(new Error("script run ended without an outcome"), input.cwd);
  return stopped ? result : { ...result, cleanup: target };

  function scopeOf() {
    return { cwd: input.cwd, workspaceId: created.workspaceId };
  }

  async function execute(): Promise<ScriptRunResult> {
    try {
      const terminal = await terminals.create({
        cwd: input.cwd,
        name: input.name,
        command,
        args,
        size: TERMINAL_SIZE,
      });
      created.id = terminal.id;
      if (terminal.workspaceId !== undefined) created.workspaceId = terminal.workspaceId;
      await input.onTerminal?.({ id: terminal.id });
    } catch (error) {
      if (error instanceof DaemonResponseLostError) created.lostCreate = true;
      return refused(error, input.cwd);
    }
    return poll(terminals, created.id, markerId, deadlineAt, scopeOf(), input, clock);
  }
}

/** Stops what a previous run left on the host, found by the id when known and else by name. */
export async function killScriptTerminal(
  terminals: TerminalConnection,
  target: ScriptCleanupTarget,
  clock: ScriptRunnerClock = systemScriptRunnerClock,
  retry: RetryRuntime = {},
): Promise<void> {
  const stopped =
    target.terminalId !== undefined
      ? await stopTerminal(terminals, target.terminalId, { cwd: target.cwd }, clock, retry)
      : await stopByName(terminals, target, clock, retry);
  if (!stopped) throw new Error("the daemon did not confirm the terminal stopped");
}

/**
 * Stops every terminal in a directory whose name carries the script prefix and that `keep` does
 * not claim, for the sweep that follows a reconnect or a restart.
 */
export async function sweepScriptTerminals(
  terminals: TerminalConnection,
  scope: { cwd: string },
  keep: (name: string) => boolean | Promise<boolean>,
  clock: ScriptRunnerClock = systemScriptRunnerClock,
  retry: RetryRuntime = {},
): Promise<{ stopped: number; unconfirmed: number }> {
  const found = await terminals.list(scope);
  let stopped = 0;
  let unconfirmed = 0;
  for (const terminal of found) {
    if (!terminal.name.startsWith(SCRIPT_TERMINAL_PREFIX) || (await keep(terminal.name))) continue;
    if (await stopTerminal(terminals, terminal.id, scope, clock, retry)) stopped += 1;
    else unconfirmed += 1;
  }
  return { stopped, unconfirmed };
}

function retryOptions(clock: ScriptRunnerClock, retry: RetryRuntime, attempts?: number) {
  const policy = retry.policy ?? KILL_BACKOFF;
  return {
    policy: attempts === undefined ? policy : { ...policy, maxAttempts: attempts },
    sleep: retry.sleep ?? ((milliseconds: number) => clock.sleep(milliseconds)),
    ...(retry.random === undefined ? {} : { random: retry.random }),
    // A refusal for permission will not change on the next try.
    isRetryable: (error: unknown) =>
      !(error instanceof DaemonTerminalError && error.code === "permission_denied"),
  };
}

class TerminalNotStopped extends Error {
  constructor() {
    super("the daemon reported the terminal was not stopped, and it is still listed");
    this.name = "TerminalNotStopped";
  }
}

/** True once the daemon confirmed the terminal is stopped, or no longer has it. */
async function stopTerminal(
  terminals: TerminalConnection,
  terminalId: string,
  scope: { cwd: string; workspaceId?: string | undefined },
  clock: ScriptRunnerClock,
  retry: RetryRuntime,
  attempts?: number,
): Promise<boolean> {
  try {
    await retryWithBackoff(
      async () => {
        if (await terminals.kill(terminalId)) return;
        // `success: false` is also what a terminal that already ended answers.
        const listed = await terminals.list(scope);
        if (listed.some(({ id }) => id === terminalId)) throw new TerminalNotStopped();
      },
      retryOptions(clock, retry, attempts),
    );
    return true;
  } catch {
    return false;
  }
}

async function stopByName(
  terminals: TerminalConnection,
  target: { cwd: string; name: string },
  clock: ScriptRunnerClock,
  retry: RetryRuntime,
  attempts?: number,
): Promise<boolean> {
  try {
    await retryWithBackoff(
      async () => {
        const found = await terminals.list({ cwd: target.cwd });
        const named = found.filter(({ name }) => name === target.name);
        for (const { id } of named) {
          if (!(await stopTerminal(terminals, id, { cwd: target.cwd }, clock, retry, attempts))) {
            throw new TerminalNotStopped();
          }
        }
      },
      retryOptions(clock, retry, attempts),
    );
    return true;
  } catch {
    return false;
  }
}

async function poll(
  terminals: TerminalConnection,
  terminalId: string,
  markerId: string,
  deadlineAt: number,
  scope: { cwd: string; workspaceId: string | undefined },
  input: ScriptRunInput,
  clock: ScriptRunnerClock,
): Promise<ScriptRunResult> {
  const startedAt = clock.now();
  const exit = new RegExp(`^${marker(markerId)}(\\d{1,3}):$`, "u");
  let lastLines: readonly string[] = [];
  let lastTotal = 0;
  let lastLivenessCheck = Number.NEGATIVE_INFINITY;
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
      // A lost capture says nothing about the script. Ask again until the deadline.
      if (capture instanceof DaemonTerminalError && capture.code === "permission_denied") {
        return { ...tailOf(lastLines, lastTotal), ...refusedFields(capture, input.cwd) };
      }
      continue;
    }
    const lines = capture.lines.map(cleanLine);
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
    if (clock.now() - lastLivenessCheck < LIVENESS_INTERVAL_MS) continue;
    lastLivenessCheck = clock.now();
    if (!(await stillListed(terminals, terminalId, scope))) {
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
  scope: { cwd: string; workspaceId: string | undefined },
): Promise<boolean> {
  try {
    return (await terminals.list(scope)).some(({ id }) => id === terminalId);
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
      return { lines: capture.lines.map(cleanLine), total: capture.totalLines };
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

/**
 * Terminal escape codes, and every control character except tab and newline. A NUL byte is
 * refused by the database's JSON column, which would lose the run's real result.
 */
function cleanLine(line: string): string {
  let clean = "";
  for (const character of stripVTControlCharacters(line)) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f;
    if (!control || code === 0x09 || code === 0x0a) clean += character;
  }
  return clean;
}

/** The last 64 KB of the lines, whole lines dropped from the front, and whether anything was cut. */
function tailOf(
  lines: readonly string[],
  totalLines: number,
): Pick<ScriptRunResult, "outputTail" | "truncated"> {
  const trimmed = lines.map(cleanLine);
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
  /** Throws unless the daemon confirmed the terminal is stopped. */
  cleanup(daemonId: string, target: ScriptCleanupTarget): Promise<void>;
  /** Stops leftover script terminals in a directory that `keep` does not claim. */
  sweep(
    daemonId: string,
    scope: { cwd: string },
    keep: (name: string) => boolean | Promise<boolean>,
  ): Promise<{ stopped: number; unconfirmed: number }>;
}

/**
 * The daemon's terminal channel, looked up again on every call: a daemon that reconnects during
 * a run replaces its connection, and a handle captured at the start would talk to a dead one.
 */
export function resolvingTerminals(
  resolve: () => TerminalConnection | undefined,
): TerminalConnection {
  const current = (): TerminalConnection => {
    const terminals = resolve();
    if (terminals === undefined) {
      throw new DaemonTerminalError("request_failed", "The daemon is not connected to this Hub.");
    }
    return terminals;
  };
  return {
    create: (options, timeoutMs) => current().create(options, timeoutMs),
    list: (scope): Promise<readonly TerminalInfo[]> => current().list(scope),
    capture: (terminalId, start) => current().capture(terminalId, start),
    kill: (terminalId) => current().kill(terminalId),
  };
}

export function createScriptStepRunner(
  connectionForDaemon: (daemonId: string) => { terminals?: TerminalConnection } | undefined,
  clock: ScriptRunnerClock = systemScriptRunnerClock,
  retry: RetryRuntime = {},
): ScriptStepRunner {
  const terminalsFor = (daemonId: string) =>
    resolvingTerminals(() => connectionForDaemon(daemonId)?.terminals);
  return {
    async run(daemonId, input) {
      if (connectionForDaemon(daemonId)?.terminals === undefined) {
        return {
          status: "failed",
          exitCode: null,
          outputTail: "",
          truncated: false,
          failureReason: "The daemon is not connected to this Hub, so it cannot run the script.",
        };
      }
      return runScript(terminalsFor(daemonId), input, clock, retry);
    },
    async cleanup(daemonId, target) {
      if (connectionForDaemon(daemonId)?.terminals === undefined) {
        throw new Error("daemon_not_connected");
      }
      await killScriptTerminal(terminalsFor(daemonId), target, clock, retry);
    },
    async sweep(daemonId, scope, keep) {
      if (connectionForDaemon(daemonId)?.terminals === undefined) {
        throw new Error("daemon_not_connected");
      }
      return sweepScriptTerminals(terminalsFor(daemonId), scope, keep, clock, retry);
    },
  };
}
