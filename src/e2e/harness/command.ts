import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SENSITIVE_FLAGS = new Set(["--api-key", "--credential", "--password", "--secret", "--token"]);
const SENSITIVE_ASSIGNMENT = /^(--(?:api-key|credential|password|secret|token))=(.*)$/iu;

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(command, args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10_000_000,
    });
  } catch (failure) {
    throw commandFailure(command, args, failure);
  }
}

function commandFailure(command: string, args: readonly string[], failure: unknown): Error {
  const cause = new Error(failureDiagnostic(failure, args));
  return new Error(`${command} ${redactCommandArguments(args).join(" ")} failed`, { cause });
}

const DIAGNOSTIC_LIMIT = 2_000;

function failureDiagnostic(failure: unknown, args: readonly string[]): string {
  const output = [outputOf(failure, "stderr"), outputOf(failure, "stdout")]
    .filter((text) => text !== "")
    .join("\n");
  if (output === "") return "child process exited unsuccessfully; raw diagnostics discarded";
  const redacted = secretValues(args).reduce(
    (text, secret) => text.split(secret).join("<redacted>"),
    output,
  );
  return `child process exited unsuccessfully; output with arguments redacted:\n${redacted.slice(-DIAGNOSTIC_LIMIT)}`;
}

function outputOf(failure: unknown, stream: "stderr" | "stdout"): string {
  const value: unknown = failure instanceof Error ? Reflect.get(failure, stream) : undefined;
  return typeof value === "string" ? value.trim() : "";
}

function secretValues(args: readonly string[]): string[] {
  const values = args.flatMap((argument, index) => {
    const previous = args[index - 1];
    if (previous !== undefined && SENSITIVE_FLAGS.has(previous)) return [argument];
    const equals = SENSITIVE_ASSIGNMENT.exec(argument);
    return equals?.[2] === undefined ? [] : [equals[2]];
  });
  return values.filter((value) => value !== "");
}

function redactCommandArguments(args: readonly string[]): string[] {
  return args.map((argument, index) => {
    if (index > 0 && SENSITIVE_FLAGS.has(args[index - 1]!)) return "<redacted>";
    const equals = SENSITIVE_ASSIGNMENT.exec(argument);
    return equals ? `${equals[1]}=<redacted>` : argument;
  });
}
