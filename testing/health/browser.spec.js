import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import { startHarness } from "../runtime/harness.mjs";

const test = base.extend({
  harness: async ({}, use) => {
    const harness = await startHarness();
    try {
      await use(harness);
    } finally {
      await harness.close();
    }
  },
  context: async ({ browser, harness }, use) => {
    const context = await browser.newContext({ baseURL: harness.url.origin });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

test("customer app shell loads without unexpected network requests or asset errors", async ({ page, harness }) => {
  const allowedOrigins = new Set([harness.customerOrigin, harness.operatorOrigin]);
  const browserErrors = [];
  let blockedRequestCount = 0;
  let failedAssetCount = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || allowedOrigins.has(url.origin)) {
      await route.continue();
      return;
    }
    blockedRequestCount += 1;
    await route.abort("blockedbyclient");
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (["script", "stylesheet"].includes(type) && response.status() >= 400) failedAssetCount += 1;
  });

  await page.goto("/");
  await expect(page.locator("#booking-entry-button")).toBeEnabled();
  await expect(page.locator("#slot-lead-hint")).toHaveText("Book at least 60 min before pickup");
  expect(browserErrors).toEqual([]);
  expect(failedAssetCount).toBe(0);
  expect(blockedRequestCount).toBe(0);

  const runDir = process.env.LIBERAIT_RUN_DIR
    || fileURLToPath(new URL(`../../test-results/infra/browser-${Date.now()}/`, import.meta.url));
  await mkdir(runDir, { recursive: true });
  await page.screenshot({ path: join(runDir, "browser-shell.png"), fullPage: true });
});
