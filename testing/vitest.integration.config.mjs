import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.mjs";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["testing/integration/**/*.test.js"],
  },
});
