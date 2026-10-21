import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  test: {
    include: ["testing/health/**/*.test.js"],
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: 30000,
    hookTimeout: 60000,
    reporters: ["default"],
  },
});
