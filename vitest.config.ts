import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  ...(process.env["HUB_VITEST_CACHE_DIR"] && { cacheDir: process.env["HUB_VITEST_CACHE_DIR"] }),
  plugins: [tanstackStart({ server: { entry: "./start-server.ts" } }), react()],
  test: {
    environment: "node",
    testTimeout: 30_000,
    setupFiles: ["./src/test-utils/real-timers.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        // Node 24 V8 frees wasm import wrappers twice under PGlite churn: https://github.com/nodejs/node/issues/66366
        execArgv: ["--no-wasm-code-gc"],
        singleFork: true,
        minForks: 1,
        maxForks: 1,
      },
    },
    exclude: ["**/node_modules/**", "**/dist/**", "**/.output/**", "**/.claude/**", "e2e/**"],
    server: {
      deps: {
        inline: [/@tanstack\/.*start/u],
      },
    },
  },
});
