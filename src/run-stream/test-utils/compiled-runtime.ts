import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { createApplicationRuntime } from "../../application-runtime.js";
import type { registerResponseLifecycle } from "../../http/response-lifecycle.js";
import { runtimeFile } from "../../runtime-files.js";
import { loadBuiltStartServer, type BuiltStartServer } from "../../server/build.js";

export interface CompiledStreamRuntime {
  build: BuiltStartServer;
  createApplicationRuntime: typeof createApplicationRuntime;
  registerResponseLifecycle: typeof registerResponseLifecycle;
  remove(): Promise<void>;
}

const compiledProducers = z.object({
  createCompiledApplicationRuntime: z.custom<typeof createApplicationRuntime>(
    (value) => typeof value === "function",
  ),
  registerCompiledResponseLifecycle: z.custom<typeof registerResponseLifecycle>(
    (value) => typeof value === "function",
  ),
});

export async function loadCompiledStreamRuntime(): Promise<CompiledStreamRuntime> {
  const original = runtimeFile(".output", "server", "start-server.js");
  const path = join(dirname(original), `.stream-boundary-${randomUUID()}.mjs`);
  const source = await readFile(original, "utf8");
  await writeFile(
    path,
    `${source}\nexport { createApplicationRuntime as createCompiledApplicationRuntime, registerResponseLifecycle as registerCompiledResponseLifecycle };\n`,
    { flag: "wx" },
  );
  try {
    const build = await loadBuiltStartServer(path);
    const producers = compiledProducers.parse(await import(pathToFileURL(path).href));
    return {
      build,
      createApplicationRuntime: producers.createCompiledApplicationRuntime,
      registerResponseLifecycle: producers.registerCompiledResponseLifecycle,
      remove: () => rm(path),
    };
  } catch (error) {
    await rm(path);
    throw error;
  }
}
