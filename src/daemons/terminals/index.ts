import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DaemonResponseLostError } from "../protocol.js";

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  workspaceId?: string | undefined;
}

export interface CreateTerminalOptions {
  cwd: string;
  name: string;
  command: string;
  args: readonly string[];
  size: { rows: number; cols: number };
}

export interface TerminalCapture {
  lines: readonly string[];
  totalLines: number;
}

/** What Hub needs from a daemon's terminal channel. The wire never reports an exit code. */
export interface TerminalConnection {
  create(options: CreateTerminalOptions, timeoutMs?: number): Promise<TerminalInfo>;
  /** Lists a workspace's terminals by its id when known, else by directory. */
  list(scope: { cwd: string; workspaceId?: string | undefined }): Promise<readonly TerminalInfo[]>;
  /** A negative `start` counts from the end of the scrollback. */
  capture(terminalId: string, start: number): Promise<TerminalCapture>;
  kill(terminalId: string): Promise<void>;
}

export type DaemonTerminalErrorCode = "permission_denied" | "no_workspace" | "request_failed";

export class DaemonTerminalError extends Error {
  constructor(
    readonly code: DaemonTerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DaemonTerminalError";
  }
}

const EnvelopeSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
});
const TerminalInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
});
const CreateResponseSchema = z.object({
  terminal: TerminalInfoSchema.nullable(),
  error: z.string().nullable(),
});
const ListResponseSchema = z.object({
  terminals: z.array(TerminalInfoSchema.partial({ cwd: true })),
});
const CaptureResponseSchema = z.object({
  lines: z.array(z.string()),
  totalLines: z.number(),
});

const RESPONSE_TYPES = new Set([
  "create_terminal_response",
  "list_terminals_response",
  "capture_terminal_response",
  "kill_terminal_response",
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DENIED_ERROR = /permission|not allowed|denied|forbidden|unauthori[sz]ed/iu;
const NO_WORKSPACE_ERROR = /workspaceId is required|no workspace|workspace (was )?not found/iu;

/**
 * The daemon's ordinary terminal requests. It knows nothing about scripts: the wrapper protocol
 * that turns a terminal into a script run lives in `script.ts`.
 */
export class DaemonTerminals implements TerminalConnection {
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly sendFrame: (frame: string) => void,
    private readonly newRequestId: () => string = randomUUID,
  ) {}

  /** Returns true when the frame answers one of this client's requests. */
  receive(value: unknown): boolean {
    const envelope = EnvelopeSchema.safeParse(value);
    if (!envelope.success) return false;
    const { type, payload } = envelope.data.message;
    const requestId = payload["requestId"];
    const pending = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (pending === undefined) return false;
    if (type === "rpc_error") {
      pending.reject(rpcError(payload));
      return true;
    }
    if (!RESPONSE_TYPES.has(type)) return false;
    pending.resolve(payload);
    return true;
  }

  close(): void {
    for (const pending of this.pending.values()) pending.reject(new DaemonResponseLostError());
    this.pending.clear();
  }

  async create(options: CreateTerminalOptions, timeoutMs?: number): Promise<TerminalInfo> {
    const response = CreateResponseSchema.parse(
      await this.request(
        {
          type: "create_terminal_request",
          cwd: options.cwd,
          name: options.name,
          command: options.command,
          args: [...options.args],
          size: options.size,
        },
        timeoutMs,
      ),
    );
    if (response.error !== null || response.terminal === null) {
      throw refusal(response.error ?? "The daemon did not create a terminal");
    }
    return response.terminal;
  }

  async list(scope: {
    cwd: string;
    workspaceId?: string | undefined;
  }): Promise<readonly TerminalInfo[]> {
    const { cwd, workspaceId } = scope;
    const response = ListResponseSchema.parse(
      await this.request({
        type: "list_terminals_request",
        ...(workspaceId === undefined ? { cwd } : { workspaceId }),
      }),
    );
    return response.terminals.flatMap((terminal) =>
      terminal.id === undefined || terminal.name === undefined
        ? []
        : [{ ...terminal, id: terminal.id, name: terminal.name, cwd: terminal.cwd ?? cwd }],
    );
  }

  async capture(terminalId: string, start: number): Promise<TerminalCapture> {
    const response = CaptureResponseSchema.parse(
      await this.request({ type: "capture_terminal_request", terminalId, start, stripAnsi: true }),
    );
    return { lines: response.lines, totalLines: response.totalLines };
  }

  async kill(terminalId: string): Promise<void> {
    await this.request({ type: "kill_terminal_request", terminalId });
  }

  private async request(
    message: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const requestId = this.newRequestId();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        timeout = setTimeout(() => reject(new DaemonResponseLostError()), timeoutMs);
        this.sendFrame(JSON.stringify({ type: "session", message: { ...message, requestId } }));
      });
    } finally {
      clearTimeout(timeout);
      this.pending.delete(requestId);
    }
  }
}

function rpcError(payload: Record<string, unknown>): DaemonTerminalError {
  const message = typeof payload["error"] === "string" ? payload["error"] : "Daemon request failed";
  const code = typeof payload["code"] === "string" ? payload["code"] : undefined;
  if (code === "access_denied" || DENIED_ERROR.test(message)) {
    return new DaemonTerminalError("permission_denied", message);
  }
  return refusal(message);
}

function refusal(message: string): DaemonTerminalError {
  return new DaemonTerminalError(
    NO_WORKSPACE_ERROR.test(message) ? "no_workspace" : "request_failed",
    message,
  );
}
