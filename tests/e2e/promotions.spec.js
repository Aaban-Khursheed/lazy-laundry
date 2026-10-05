import { expect, test } from "@playwright/test";

function dateAfter(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function slotsForDate(dateString) {
  const weekday = new Date(`${dateString}T12:00:00+08:00`).getUTCDay();
  return weekday === 0 || weekday === 6
    ? ["10:00", "11:00", "12:00", "19:00", "20:00", "21:00"]
    : ["19:00", "20:00", "21:00"];
}

async function apiFetch(page, path, options = {}) {
  return page.evaluate(async ({ path: requestPath, options: requestOptions }) => {
    const response = await fetch(requestPath, {
      ...requestOptions,
      headers: { "Content-Type": "application/json", ...(requestOptions.headers || {}) },
    });
    return { status: response.status, body: await response.json() };
  }, { path, options });
}

const OPERATOR_HEADERS = { "X-Local-Operator-Email": "local.operator@example.invalid" };

async function findFreeSlot(page) {
  for (let offset = 1; offset <= 6; offset += 1) {
    const candidate = dateAfter(offset);
    const availability = await apiFetch(page, `/api/availability?date=${candidate}`, { method: "GET" });
    const booked = new Set(availability.body.bookedSlots || []);
    const free = slotsForDate(candidate).find((slot) => !booked.has(slot));
    if (free) return { pickupDate: candidate, pickupSlot: free };
  }
  return null;
}

function bookingPayload(slot, overrides = {}) {
  return {
    name: "Promo Smoke",
    phone: `+601${String(Date.now()).slice(-8)}`,
    block: "Block A/B",
    unit: "A-8-02",
    packageSize: 10,
    service: "standard",
    hangers: false,
    paymentMethod: "cash",
    termsAccepted: true,
    ...slot,
    ...overrides,
  };
}

async function createPromo(page, fields) {
  return apiFetch(page, "/api/operator/promotions", {
    method: "POST",
    headers: OPERATOR_HEADERS,
    body: JSON.stringify(fields),
  });
}

test("operator promotions apply discounts to checkout and tracking end to end", async ({ page }) => {
  const ops = await page.context().newPage();
  await ops.goto("http://ops.localhost:8787");
  await page.goto("/");
  const code = `E2E${String(Date.now()).slice(-9)}`;

  const created = await createPromo(ops, {
    code,
    description: "E2E launch promo",
    kind: "percent",
    value: 10,
    minService: 0,
    maxRedemptions: null,
    active: true,
  });
  expect(created.status).toBe(201);
  expect(created.body.promotion.code).toBe(code);
  expect(created.body.promotion.active).toBe(true);
  expect(created.body.promotion.revision).toBe(1);

  const duplicate = await createPromo(ops, { code, kind: "percent", value: 10 });
  expect(duplicate.status).toBe(409);

  const listed = await apiFetch(ops, "/api/operator/promotions", { method: "GET", headers: OPERATOR_HEADERS });
  expect(listed.status).toBe(200);
  expect(listed.body.promotions.some((promo) => promo.code === code)).toBe(true);

  const slot = await findFreeSlot(page);
  test.skip(!slot, "The local test database has no free pickup slot");

  const phone = `+601${String(Date.now()).slice(-8)}`;
  const quote = await apiFetch(page, "/api/estimate", {
    method: "POST",
    body: JSON.stringify({ phone, packageSize: 10, service: "standard", hangers: false, promoCode: code.toLowerCase() }),
  });
  expect(quote.status).toBe(200);
  expect(quote.body.promo.applied).toBe(true);
  expect(quote.body.promo.discount).toBe(2.99);
  expect(quote.body.lines.find((line) => line.key === "promo").amount).toBe(-2.99);
  expect(quote.body.total).toBe(27);

  const createdBooking = await apiFetch(page, "/api/bookings", {
    method: "POST",
    headers: { "X-Idempotency-Key": `promo-${crypto.randomUUID()}` },
    body: JSON.stringify(bookingPayload(slot, { phone, promoCode: code, expectedTotalCents: 2700 })),
  });
  expect(createdBooking.status).toBe(201);
  expect(createdBooking.body.booking.promoCode).toBe(code);
  expect(createdBooking.body.booking.discount).toBe(2.99);
  expect(createdBooking.body.booking.total).toBe(27);

  const tracked = await apiFetch(page, "/api/track", {
    method: "POST",
    body: JSON.stringify({ number: createdBooking.body.booking.number, token: createdBooking.body.trackingToken }),
  });
  expect(tracked.status).toBe(200);
  expect(tracked.body.discount).toBe(2.99);
  expect(tracked.body.promoCode).toBe(code);
  expect(tracked.body.total).toBe(27);

  const detail = await apiFetch(ops, `/api/operator/bookings/${createdBooking.body.booking.id}`, {
    method: "GET",
    headers: OPERATOR_HEADERS,
  });
  expect(detail.status).toBe(200);
  expect(detail.body.booking.discount).toBe(2.99);
  expect(detail.body.booking.promo.code).toBe(code);
});

test("invalid, deactivated, and exhausted promo codes never discount a booking", async ({ page }) => {
  const ops = await page.context().newPage();
  await ops.goto("http://ops.localhost:8787");
  await page.goto("/");
  const phone = `+601${String(Date.now()).slice(-8)}`;

  const bogus = await apiFetch(page, "/api/estimate", {
    method: "POST",
    body: JSON.stringify({ phone, packageSize: 10, service: "standard", hangers: false, promoCode: "NOSUCHCODE123" }),
  });
  expect(bogus.status).toBe(200);
  expect(bogus.body.promo.applied).toBe(false);
  expect(bogus.body.promo.message).toBeTruthy();
  expect(bogus.body.total).toBe(29.99);
  expect(bogus.body.lines.some((line) => line.key === "promo")).toBe(false);

  const code = `CAP${String(Date.now()).slice(-9)}`;
  const capped = await createPromo(ops, { code, kind: "fixed", value: 5, maxRedemptions: 1 });
  expect(capped.status).toBe(201);

  const slot = await findFreeSlot(page);
  test.skip(!slot, "The local test database has no free pickup slot");

  const winnerQuote = await apiFetch(page, "/api/estimate", {
    method: "POST",
    body: JSON.stringify({ phone: `+602${String(Date.now()).slice(-8)}`, packageSize: 10, service: "standard", hangers: false, promoCode: code }),
  });
  expect(winnerQuote.body.promo.applied).toBe(true);
  expect(winnerQuote.body.total).toBe(24.99);

  const first = await apiFetch(page, "/api/bookings", {
    method: "POST",
    headers: { "X-Idempotency-Key": `promo-cap-${crypto.randomUUID()}` },
    body: JSON.stringify(bookingPayload(slot, { phone: `+602${String(Date.now()).slice(-8)}`, promoCode: code, expectedTotalCents: 2499 })),
  });
  expect(first.status).toBe(201);
  expect(first.body.booking.discount).toBe(5);

  const secondSlot = await findFreeSlot(page);
  test.skip(!secondSlot, "The local test database has no second free pickup slot");

  const spentQuote = await apiFetch(page, "/api/estimate", {
    method: "POST",
    body: JSON.stringify({ phone: `+603${String(Date.now()).slice(-8)}`, packageSize: 10, service: "standard", hangers: false, promoCode: code }),
  });
  expect(spentQuote.body.promo.applied).toBe(false);
  expect(spentQuote.body.total).toBe(29.99);

  const second = await apiFetch(page, "/api/bookings", {
    method: "POST",
    headers: { "X-Idempotency-Key": `promo-cap-2-${crypto.randomUUID()}` },
    body: JSON.stringify(bookingPayload(secondSlot, { phone: `+603${String(Date.now()).slice(-8)}`, promoCode: code, expectedTotalCents: 2499 })),
  });
  expect(second.status).toBe(409);

  const off = await apiFetch(ops, `/api/operator/promotions/${capped.body.promotion.id}`, {
    method: "PATCH",
    headers: OPERATOR_HEADERS,
    body: JSON.stringify({ revision: 1, fields: { active: false } }),
  });
  expect(off.status).toBe(200);
  expect(off.body.promotion.active).toBe(false);

  const offlineQuote = await apiFetch(page, "/api/estimate", {
    method: "POST",
    body: JSON.stringify({ phone: `+604${String(Date.now()).slice(-8)}`, packageSize: 10, service: "standard", hangers: false, promoCode: code }),
  });
  expect(offlineQuote.body.promo.applied).toBe(false);
  expect(offlineQuote.body.total).toBe(29.99);
});

test("customer checkout applies a promo code and shows the price cut clearly", async ({ page }) => {
  const ops = await page.context().newPage();
  await ops.goto("http://ops.localhost:8787");
  const code = `UI${String(Date.now()).slice(-9)}`;
  const created = await createPromo(ops, { code, kind: "percent", value: 20 });
  expect(created.status).toBe(201);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#booking-entry-button").click();
  const day = await findFreeSlot(page);
  test.skip(!day, "The local test database has no free pickup slot");
  const dayIndex = await page.evaluate((target) => {
    const days = [...document.querySelectorAll("#calendar-grid .calendar-day")];
    return days.findIndex((d) => d.dataset.date === target || d.getAttribute("data-date") === target);
  }, day.pickupDate);
  if (dayIndex >= 0) {
    await page.locator("#calendar-grid .calendar-day").nth(dayIndex).click();
  } else {
    await page.locator("#calendar-grid .calendar-day").last().click();
  }
  const chosenDate = await page.locator("#pickup-date").inputValue();
  const bookedSlots = await page.evaluate(async (date) => {
    const r = await fetch(`/api/availability?date=${date}`);
    const body = await r.json();
    return body.bookedSlots || [];
  }, chosenDate);
  const open = page.locator(".slot-button.open");
  const count = await open.count();
  let picked = false;
  for (let i = 0; i < count; i += 1) {
    const slot = await open.nth(i).getAttribute("data-slot");
    if (!bookedSlots.includes(slot)) { await open.nth(i).click(); picked = true; break; }
  }
  if (!picked) await open.first().click();
  await page.locator("#checkout-button").click();
  await expect(page.locator("#checkout-view")).toBeVisible();

  await page.locator("#customer-name").fill("Promo Customer");
  await page.locator("#customer-phone").fill(`${String(Date.now()).slice(-8)}`);
  await page.locator("#customer-block").selectOption("Block A/B");
  await page.locator("#customer-unit").fill("A-8-02");
  await page.locator("#customer-promo").fill(code.toLowerCase());
  await page.locator("#promo-apply").click();
  await expect(page.locator("#promo-note")).toContainText(`${code} applied`);
  await expect(page.locator("#checkout-price-breakdown .breakdown-row-promo")).toBeVisible();
  await page.screenshot({ path: "test-results/promo-checkout.png", animations: "disabled" });
  await expect(page.locator("#checkout-total-price")).not.toHaveText("RM29.99");

  await page.locator(".terms-row").click();
  await page.locator("#booking-form [type=submit]").click();
  await expect(page.locator("#confirmation-view")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#confirmation-view .order-meta-discount")).toContainText(code);
});

test("operator promotions view creates and toggles codes live", async ({ page }) => {
  await page.goto("http://ops.localhost:8787");
  await page.locator('[data-operator-view="promos"]').click();
  await expect(page.locator("#operator-promos")).toBeVisible();
  await expect(page.locator("#operator-queue-view")).toBeHidden();

  const code = `OPS${String(Date.now()).slice(-9)}`;
  await page.locator("#promo-code").fill(code);
  await page.locator("#promo-kind").selectOption("percent");
  await page.locator("#promo-value").fill("15");
  await page.locator("#promo-min").fill("20");
  await page.locator("#operator-promo-submit").click();
  await expect(page.locator(".operator-dialog")).toBeVisible();
  await page.locator(".operator-dialog [type=submit]").click();
  await expect(page.locator("#operator-promo-success")).toContainText(code);

  const item = page.locator(".operator-promo-item", { hasText: code });
  await expect(item).toBeVisible();
  await expect(item).toContainText("15% off");
  await expect(item).toContainText("Live");

  await item.locator("[data-promo-toggle]").click();
  await expect(page.locator(".operator-dialog")).toBeVisible();
  await page.locator(".operator-dialog [type=submit]").click();
  await expect(item).toContainText("Off");

  const customer = await page.context().newPage();
  await customer.goto("http://localhost:8787");
  const quote = await customer.evaluate(async (promoCode) => {
    const r = await fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+60199990000", packageSize: 10, service: "standard", hangers: false, promoCode }) });
    return r.json();
  }, code);
  expect(quote.promo.applied).toBe(false);
});
