import { expect, test } from "@playwright/test";

// Runs against the real local dev server (`npm run test:e2e` starts it).
// Whole-day blocks are used so the test does not depend on weekday/weekend
// slot schedules.

const OPERATOR_HEADERS = { "X-Local-Operator-Email": "local.operator@example.invalid" };

function klDateString(daysAhead) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + daysAhead * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}

async function apiFetch(page, path, options = {}) {
  return page.evaluate(async ([url, init]) => {
    const response = await fetch(url, {
      method: init.method || "GET",
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    let body = null;
    try { body = await response.json(); } catch { /* non-json */ }
    return { status: response.status, body };
  }, [path, options]);
}

test("operator capacity block hides the date from customers until removed", async ({ page }) => {
  const date = klDateString(2);
  await page.goto("http://ops.localhost:8787");

  // Test-data hygiene: remove any stale block on this date from a previous run.
  const existing = await apiFetch(page, "/api/operator/blocked-slots", { headers: OPERATOR_HEADERS });
  for (const block of existing.body?.blocks || []) {
    if (block.pickupDate === date) await apiFetch(page, `/api/operator/blocked-slots/${block.id}`, { method: "DELETE", headers: OPERATOR_HEADERS });
  }
  await page.reload();

  await page.locator('[data-operator-view="capacity"]').click();
  await page.locator('[data-operator-view="capacity"]').click();
  await expect(page.locator("#operator-capacity")).toBeVisible();
  await expect(page.locator("#operator-queue-view")).toBeHidden();

  await page.locator("#capacity-date").fill(date);
  await expect(page.locator("#capacity-slot")).toHaveValue("");
  await page.locator("#capacity-reason").fill("Playwright capacity test");
  await page.locator("#operator-capacity-submit").click();
  await expect(page.locator(".operator-dialog")).toBeVisible();
  await page.locator(".operator-dialog [type=submit]").click();
  await expect(page.locator("#operator-capacity-success")).toContainText("blocked");

  const item = page.locator(".operator-promo-item", { hasText: "Playwright capacity test" });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Whole day");

  const customer = await page.context().newPage();
  await customer.goto("http://localhost:8787");
  const availability = await customer.evaluate(async (d) => {
    const r = await fetch(`/api/availability?date=${d}`);
    return r.json();
  }, date);
  expect(availability.blockedDate).toBe(true);

  const rejected = await apiFetch(customer, "/api/bookings", {
    method: "POST",
    headers: { "X-Idempotency-Key": `capacity-e2e-${Date.now()}` },
    body: {
      name: "E2E Blocked", phone: "+60199998888", block: "Block A/B", unit: "A-8-02",
      packageSize: 10, service: "standard", hangers: false, pickupDate: date,
      pickupSlot: "19:00", paymentMethod: "cash", termsAccepted: true,
    },
  });
  expect(rejected.status).toBe(409);
  expect(rejected.body.code).toBe("slot_unavailable");

  await item.locator("[data-capacity-delete]").click();
  await expect(page.locator(".operator-dialog")).toBeVisible();
  await page.locator(".operator-dialog [type=submit]").click();
  await expect(page.locator("#operator-capacity-success")).toContainText("open for bookings again");
  await expect(item).toHaveCount(0);

  const reopened = await customer.evaluate(async (d) => {
    const r = await fetch(`/api/availability?date=${d}`);
    return r.json();
  }, date);
  expect(reopened.blockedDate).toBe(false);
});
