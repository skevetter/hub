import { z } from "zod";
import { DaemonTerminals } from "../terminals/index.js";
import type { ScriptRunnerClock } from "../terminals/script.js";

interface FakeTerminal {
  id: string;
  name: string;
  cwd: string;
  lines: string[];
  /** Rows scrolled out of the capture window, as the daemon's 10000 line scrollback would. */
  scrolledOff: number;
  listed: boolean;
}

export interface CreatedTerminal {
  command: string | undefined;
  args: string[] | undefined;
  cwd: string;
  name: string | undefined;
  size: { rows: number; cols: number } | undefined;
}

const FrameSchema = z.object({ message: z.record(z.string(), z.unknown()) });
const CreateRequestSchema = z.object({
  requestId: z.unknown(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string(),
  name: z.string().optional(),
  size: z.object({ rows: z.number(), cols: z.number() }).optional(),
});

/** A virtual clock: sleeping advances time and runs whatever the test scheduled up to it. */
export class FakeClock implements ScriptRunnerClock {
  time = 0;
  private readonly timers: { at: number; run: () => void }[] = [];
  private uuid = 0;

  now(): number {
    return this.time;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.time += milliseconds;
    for (const timer of this.timers.filter(({ at }) => at <= this.time)) {
      this.timers.splice(this.timers.indexOf(timer), 1);
      timer.run();
    }
    await Promise.resolve();
  }

  /** Run `action` the first time the clock reaches `at` milliseconds. */
  at(at: number, action: () => void): void {
    this.timers.push({ at, run: action });
  }

  /** The id `random` returned on its `call`th use. */
  uuidFor(call: number): string {
    return `00000000-0000-4000-8000-${String(call).padStart(12, "0")}`;
  }

  random(): string {
    this.uuid += 1;
    return `00000000-0000-4000-8000-${String(this.uuid).padStart(12, "0")}`;
  }
}

/**
 * A daemon terminal channel that answers the real wire frames. It never runs a process: a test
 * decides what the "PTY" prints and when the wrapper reports an exit code.
 */
export class FakeTerminalDaemon {
  readonly created: CreatedTerminal[] = [];
  readonly killed: string[] = [];
  readonly requests: Record<string, unknown>[] = [];
  readonly listRequests: Record<string, unknown>[] = [];
  readonly terminals = new Map<string, FakeTerminal>();
  /** Request types answered with a permission refusal. */
  readonly denied = new Set<string>();
  /** Request types never answered, as when a response is lost. */
  readonly silent = new Set<string>();
  /** The next this many kill requests fail with a daemon error. */
  failKills = 0;
  /** Kill requests answer `success: false` and leave the terminal running while this is false. */
  killSucceeds = true;
  /** Every kill request that reached the daemon, including failed ones. */
  readonly killAttempts: string[] = [];
  createError: string | undefined;
  captureError: string | undefined;
  readonly client: DaemonTerminals;
  private nextId = 0;

  constructor() {
    this.client = new DaemonTerminals(
      (frame) => this.handle(frame),
      () => `request-${String(++this.requestCount)}`,
    );
  }

  private requestCount = 0;

  /** The terminal created last. */
  get terminal(): FakeTerminal {
    const terminal = [...this.terminals.values()].at(-1);
    if (terminal === undefined) throw new Error("no terminal was created");
    return terminal;
  }

  /** The id the wrapper command prints in its exit marker. */
  markerId(terminal = this.terminal): string {
    const created = this.created[Number(terminal.id.split("-")[1]) - 1];
    const match = /__HUB_EXIT_([0-9a-f-]+)__/u.exec(created?.args?.[1] ?? "");
    if (match?.[1] === undefined) throw new Error("the wrapper has no exit marker");
    return match[1];
  }

  print(text: string, terminal = this.terminal): void {
    terminal.lines.push(...text.split("\n"));
  }

  /** What the wrapper prints when the script ends, as a complete line. */
  exit(code: number, terminal = this.terminal): void {
    terminal.lines.push("", `__HUB_EXIT_${this.markerId(terminal)}__:${String(code)}:`);
  }

  /** The record disappears, as it does when the process ends or someone closes the terminal. */
  remove(terminal = this.terminal): void {
    terminal.listed = false;
    terminal.lines = [];
    terminal.scrolledOff = 0;
  }

  private handle(frame: string): void {
    const { message } = FrameSchema.parse(JSON.parse(frame));
    this.requests.push(message);
    const type = String(message["type"]);
    const requestId = message["requestId"];
    if (this.silent.has(type)) return;
    if (this.denied.has(type)) {
      this.reply("rpc_error", {
        requestId,
        requestType: type,
        error: "Operation not permitted",
        code: "access_denied",
      });
      return;
    }
    if (type === "create_terminal_request") return this.create(message);
    if (type === "list_terminals_request") {
      this.listRequests.push(message);
      return this.reply("list_terminals_response", {
        requestId,
        terminals: [...this.terminals.values()]
          .filter((terminal) => terminal.listed)
          .map(({ id, name, cwd }) => ({ id, name, cwd })),
      });
    }
    if (type === "capture_terminal_request") return this.capture(message);
    if (type === "kill_terminal_request") return this.kill(message, requestId);
    throw new Error(`unexpected terminal request ${type}`);
  }

  private kill(message: Record<string, unknown>, requestId: unknown): void {
    const id = String(message["terminalId"]);
    this.killAttempts.push(id);
    if (this.failKills > 0) {
      this.failKills -= 1;
      return this.reply("rpc_error", { requestId, error: "terminal worker busy" });
    }
    const terminal = this.terminals.get(id);
    if (!this.killSucceeds) {
      return this.reply("kill_terminal_response", { requestId, terminalId: id, success: false });
    }
    this.killed.push(id);
    const success = terminal?.listed === true;
    if (terminal !== undefined) terminal.listed = false;
    return this.reply("kill_terminal_response", { requestId, terminalId: id, success });
  }

  private create(message: Record<string, unknown>): void {
    const request = CreateRequestSchema.parse(message);
    const requestId = request.requestId;
    this.created.push({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      name: request.name,
      size: request.size,
    });
    if (this.createError !== undefined) {
      this.reply("create_terminal_response", {
        requestId,
        terminal: null,
        error: this.createError,
      });
      return;
    }
    this.nextId += 1;
    const terminal: FakeTerminal = {
      id: `terminal-${String(this.nextId)}`,
      name: request.name ?? "",
      cwd: request.cwd,
      lines: [],
      scrolledOff: 0,
      listed: true,
    };
    this.terminals.set(terminal.id, terminal);
    this.reply("create_terminal_response", {
      requestId,
      error: null,
      terminal: { id: terminal.id, name: terminal.name, cwd: terminal.cwd, workspaceId: "ws-1" },
    });
  }

  private capture(message: Record<string, unknown>): void {
    const requestId = message["requestId"];
    if (this.captureError !== undefined) {
      this.reply("rpc_error", { requestId, error: this.captureError });
      return;
    }
    const terminal = this.terminals.get(String(message["terminalId"]));
    if (terminal === undefined || !terminal.listed) {
      return this.reply("capture_terminal_response", {
        requestId,
        terminalId: message["terminalId"],
        lines: [],
        totalLines: 0,
      });
    }
    const start = Number(message["start"]);
    const lines = start < 0 ? terminal.lines.slice(start) : terminal.lines.slice(start);
    this.reply("capture_terminal_response", {
      requestId,
      terminalId: terminal.id,
      lines,
      totalLines: terminal.lines.length + terminal.scrolledOff,
    });
  }

  private reply(type: string, payload: Record<string, unknown>): void {
    this.client.receive({ type: "session", message: { type, payload } });
  }
}
