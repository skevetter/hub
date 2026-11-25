import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "vitest";
import { runCommand } from "./command.js";

describe("E2E command diagnostics", () => {
  it("does not retain a failed command's enrollment token", async () => {
    const token = "exact-enrollment-token-must-not-survive";

    const diagnostic = await failedCommandDiagnostic(token);

    assert.equal(diagnostic.includes(token), false);
    assert.match(diagnostic, /--token <redacted>/u);
    assert.match(diagnostic, /raw diagnostics discarded/u);
  });

  it("keeps a failed command's error output with its secret arguments redacted", async () => {
    const token = "exact-enrollment-token-must-not-survive";

    const diagnostic = await failedCommandDiagnostic(token, `bad credential ${token} rejected`);

    assert.equal(diagnostic.includes(token), false);
    assert.match(diagnostic, /bad credential <redacted> rejected/u);
  });

  it("keeps only the tail of long error output", async () => {
    const diagnostic = await failedCommandDiagnostic("unused", `${"x".repeat(5_000)}END`);

    assert.match(diagnostic, /xEND/u);
    assert.equal(diagnostic.includes("x".repeat(2_100)), false);
  });
});

async function failedCommandDiagnostic(token: string, stderr = ""): Promise<string> {
  try {
    await runCommand(
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.env.FAILURE_OUTPUT ?? ''); process.exit(3)",
        "--",
        "--token",
        token,
      ],
      process.cwd(),
      { FAILURE_OUTPUT: stderr },
    );
  } catch (error) {
    return inspect(error, { depth: 10 });
  }
  throw new Error("Command unexpectedly succeeded");
}
