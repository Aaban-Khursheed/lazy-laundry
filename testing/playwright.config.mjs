import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./health",
  testMatch: "**/browser.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});
