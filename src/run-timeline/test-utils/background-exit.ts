import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function assertBackgroundSweepExits(
  mode: "reconciliation" | "retention" | "retention_pause" | "accounting",
): Promise<void> {
  const result = await execute(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./background-process.ts", import.meta.url)), mode],
    { timeout: 10_000 },
  );
  assert.equal(result.stdout, "ready\n");
}
