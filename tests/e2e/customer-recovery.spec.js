import { expect, test } from "@playwright/test";
import { getMaxBookingDateString, getSlotsForDate } from "../../public/shared/utils.js";

const token = "t".repeat(43);
const number = "LL-AB12CD34";
const quote = (total = 29.99, revision = "first") => ({
  revision, total, lines: [{ label: "Laundry service", amount: 29.99 }, ...(total > 29.99 ? [{ label: "Outstanding service fee", amount: total - 29.99 }] : [])],
});
const record = () => ({
  number, packageSize: 10, service: "standard", pickupDate: getMaxBookingDateString(), pickupSlot: "19:00",
  readyTime: "Next day · MYT", status: "Confirmed", total: 29.99, canCancel: true, canReschedule: true, canEdit: true,
});
const editView = (overrides = {}) => ({
  number, name: "Synthetic Customer", block: "Block A/B", unit: "A-12-03", packageSize: 10, service: "standard",
  folding: true, ironing: true, hangers: false, paymentMethod: "cash", pickupDate: getMaxBookingDateString(), pickupSlot: "19:00",
  serviceTotal: 29.99, feeTotal: 0, total: 29.99, readyAt: null, readyTime: "Next day · MYT", status: "Confirmed",
  canEdit: true, editLate: false, ...overrides,
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixtures(page, { config, estimate, availability, track, mutation, booking } = {}) {
  const calls = { bookings: [], actions: [], estimates: [], tracks: [], availability: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/config") return config ? config(route) : route.fulfill({ json: { bookingEnabled: true, turnstileSiteKey: "" } });
    if (path === "/api/availability") {
      const date = new URL(request.url()).searchParams.get("date");
      calls.availability.push(date);
      return availability ? availability(route, date) : route.fulfill({ json: { date, bookedSlots: [] } });
    }
    if (path === "/api/estimate") {
      calls.estimates.push(request.postDataJSON());
      return estimate ? estimate(route, calls.estimates.length) : route.fulfill({ json: quote() });
    }
    if (path === "/api/bookings") {
      calls.bookings.push({ body: request.postDataJSON(), key: request.headers()["x-idempotency-key"] });
      return booking ? booking(route, calls.bookings.length) : route.fulfill({ json: { booking: record(), trackingToken: token } });
    }
    if (path === "/api/track") {
      calls.tracks.push(request.postDataJSON());
      return track ? track(route, calls.tracks.length) : route.fulfill({ json: record() });
    }
    if (/\/api\/bookings\/[^/]+\/(reschedule|cancel|edit)$/.test(path)) {
      calls.actions.push({ path, body: request.postDataJSON() });
      return mutation ? mutation(route, calls.actions.length) : route.fulfill({ json: { booking: record() } });
    }
    return route.continue();
  });
  return calls;
}

async function checkout(page) {
  await page.goto("/");
  await page.locator("#booking-entry-button").click();
  await page.locator("#calendar-grid .calendar-day").last().click();
  await page.locator(".slot-button.open").first().click();
  await page.locator("#checkout-button").click();
  await page.locator("#customer-name").fill("Synthetic Customer");
  await page.locator("#customer-block").selectOption("Block A/B");
  await page.locator("#customer-unit").fill("A-12-03");
  await page.locator(".terms-box").click();
  await expect(page.locator("#terms-accepted")).toBeChecked();
  await page.locator("#customer-phone").fill("123456789");
}

async function lookup(page) {
  await page.goto("/track");
  await page.locator("#tracking-number").fill(number);
  await page.locator("#tracking-token").fill(token);
  await page.locator("#track-button").click();
  await expect(page.locator("#tracking-result h3")).toHaveText(number);
}

async function verifyPhone(page, action) {
  await page.locator(`[data-customer-open="${action}"]`).click();
  await expect(page.locator("#tracking-verify")).toBeVisible();
  const phone = page.locator("#tracking-action-phone");
  if (!(await phone.inputValue())) await phone.fill("+60123456789");
  await page.locator("#tracking-verify-continue").click();
}

const browserErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

test("submission locks before a delayed quote and ignores duplicate Enter/submits", async ({ page }) => {
  const calls = await fixtures(page, { estimate: async (route) => { await pause(700); await route.fulfill({ json: quote() }); } });
  await checkout(page);
  await page.locator("#customer-phone").press("Enter");
  await page.keyboard.press("Enter");
  await page.locator("#booking-form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await expect(page.locator("#customer-name")).toBeDisabled();
  await expect(page.locator('#checkout-view [data-view-target="booking-view"]').first()).toBeDisabled();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.bookings).toHaveLength(1);
  expect(calls.estimates).toHaveLength(1);
});

test("failed quote cannot submit a fallback lower total", async ({ page }) => {
  const calls = await fixtures(page, { estimate: (route) => route.fulfill({ status: 503, json: { error: "Estimate unavailable" } }) });
  await checkout(page);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#form-error")).toContainText(/quote|estimate/i);
  await expect(page.locator("#customer-name")).toBeEnabled();
  expect(calls.bookings).toHaveLength(0);
});

test("quote_changed refreshes the disclosed fee total for review and keeps the pickup", async ({ page }) => {
  let changed = false;
  const calls = await fixtures(page, {
    estimate: (route) => route.fulfill({ json: changed ? quote(32.99, "second") : quote() }),
    booking: (route, count) => {
      if (count === 1) { changed = true; return route.fulfill({ status: 409, json: { code: "quote_changed", error: "The price has changed" } }); }
      return route.fulfill({ json: { booking: { ...record(), total: 32.99 }, trackingToken: token } });
    },
  });
  await checkout(page);
  const slot = await page.locator("#pickup-slot").inputValue();
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#checkout-total-price")).toHaveText("RM32.99");
  await expect(page.locator("#form-error")).toContainText(/review/i);
  await expect(page.locator("#checkout-price-breakdown")).toContainText("Outstanding service fee");
  await expect(page.locator("#pickup-slot")).toHaveValue(slot);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.bookings[1].body.expectedTotalCents).toBe(3299);
  expect(calls.bookings[1].key).not.toBe(calls.bookings[0].key);
});

test("lost response retries exactly the original key and body even after quote and date change", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-04T15:55:00Z") });
  let changed = false;
  const calls = await fixtures(page, {
    estimate: (route) => route.fulfill({ json: changed ? quote(35.99, "changed") : quote() }),
    booking: (route, count) => {
      if (count === 1) { changed = true; return route.abort("failed"); }
      return route.fulfill({ json: { booking: record(), trackingToken: token } });
    },
  });
  await checkout(page);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#form-error")).toContainText(/confirmation could not be verified.*retry.*same booking/i);
  await expect(page.locator("#customer-name")).toBeDisabled();
  await expect(page.locator('#checkout-view [data-view-target="booking-view"]').first()).toBeDisabled();
  const originalDate = await page.locator("#pickup-date").inputValue();
  await page.locator("#customer-phone").dispatchEvent("blur");
  await page.clock.setSystemTime(new Date("2026-10-12T16:05:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pause(400);
  await expect(page.locator("#pickup-date")).toHaveValue(originalDate);
  expect(calls.estimates).toHaveLength(1);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.bookings).toHaveLength(2);
  expect(calls.bookings[1]).toEqual(calls.bookings[0]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("config failure blocks intake but not tracking and has an explicit working retry", async ({ page }) => {
  let available = false;
  await fixtures(page, { config: (route) => available ? route.fulfill({ json: { bookingEnabled: true, turnstileSiteKey: "" } }) : route.fulfill({ status: 503, json: { error: "Config unavailable" } }) });
  await page.goto("/");
  await expect(page.locator("#booking-entry-button")).toBeDisabled();
  await expect(page.locator("#booking-config-retry")).toBeVisible();
  await expect(page.locator('[data-view-target="tracking-view"]').first()).toBeEnabled();
  available = true;
  await page.locator("#booking-config-retry").click();
  await expect(page.locator("#booking-entry-button")).toBeEnabled();
  await expect(page.locator("#booking-entry-button .button-arrow")).toHaveCount(1);
});

test("config must validate before intake is enabled", async ({ page }) => {
  await fixtures(page, { config: (route) => route.fulfill({ json: {} }) });
  await page.goto("/");
  await expect(page.locator("#booking-config-retry")).toBeVisible();
  await expect(page.locator("#booking-entry-button")).toBeDisabled();
});

test("rescheduling fetches fresh eligibility and supports repeated eligible changes", async ({ page }) => {
  let current = record();
  const calls = await fixtures(page, {
    track: (route) => route.fulfill({ json: current }),
    mutation: (route) => { const body = route.request().postDataJSON(); current = { ...current, pickupDate: body.pickupDate, pickupSlot: body.pickupSlot }; return route.fulfill({ json: { booking: current } }); },
  });
  await lookup(page);
  for (const slot of ["20:00", "21:00"]) {
    await verifyPhone(page, "reschedule");
    await page.locator("#tracking-reschedule-slot").selectOption(slot);
    await page.locator('[data-customer-action="reschedule"]').click();
    await page.locator("#tracking-confirm-yes").click();
    await expect.poll(() => calls.tracks.length).toBe(slot === "20:00" ? 2 : 3);
    await expect(page.locator('[data-customer-open="reschedule"]')).toBeEnabled();
  }
  expect(calls.actions).toHaveLength(2);
});

test("successful write plus failed fresh lookup offers Refresh status without repeating the mutation", async ({ page }) => {
  let failed = true;
  const calls = await fixtures(page, { track: (route, count) => count > 1 && failed ? route.fulfill({ status: 503, json: { error: "Tracking unavailable" } }) : route.fulfill({ json: record() }) });
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await page.locator("#tracking-reschedule-slot").selectOption("20:00");
  await page.locator('[data-customer-action="reschedule"]').click();
  await page.locator("#tracking-confirm-yes").click();
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeVisible();
  await expect(page.locator("#tracking-result")).toContainText(/saved|succeeded/i);
  failed = false;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.locator('[data-customer-open="reschedule"]')).toBeEnabled();
  expect(calls.actions).toHaveLength(1);
});

test("tracking 404 is generic but availability and tracking 503/429 remain retryable", async ({ page }) => {
  let status = 404;
  await fixtures(page, { track: (route) => route.fulfill({ status, json: { error: "Internal detail should not appear" } }) });
  await page.goto("/track");
  await page.locator("#tracking-number").fill(number);
  await page.locator("#tracking-token").fill(token);
  await page.locator("#track-button").click();
  await expect(page.locator("#tracking-error")).toContainText("Check the number and private token");
  await expect(page.locator("#tracking-error")).not.toContainText("Internal detail");
  for (status of [503, 429]) {
    await page.locator("#track-button").click();
    await expect(page.locator("#tracking-error")).toContainText(/retry|try again/i);
    await expect(page.locator("#tracking-error")).not.toContainText("could not find");
  }
});

test("editing lookup credentials invalidates the old record actions", async ({ page }) => {
  const calls = await fixtures(page);
  await lookup(page);
  await page.locator("#tracking-token").fill("other-private-token");
  await expect(page.locator("[data-customer-action]")).toHaveCount(0);
  await page.locator("#tracking-number").fill("invalid");
  await page.locator("#track-button").click();
  await expect(page.locator("#tracking-error")).toContainText("Enter your booking number");
  expect(calls.actions).toHaveLength(0);
});

test("reschedule choices wait for availability, exclude taken slots and allow the original slot", async ({ page }) => {
  let available = false;
  const calls = await fixtures(page, { availability: async (route, date) => {
    await pause(250);
    return available ? route.fulfill({ json: { date, bookedSlots: ["19:00", "21:00"] } }) : route.fulfill({ status: 503, json: { error: "Availability unavailable" } });
  } });
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry availability", exact: true })).toBeVisible();
  available = true;
  await page.getByRole("button", { name: "Retry availability", exact: true }).click();
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  expect(await page.locator("#tracking-reschedule-slot option:enabled").evaluateAll((options) => options.map((option) => option.value))).toEqual(getSlotsForDate(getMaxBookingDateString()).filter((slot) => slot !== "21:00"));
  expect(calls.actions).toHaveLength(0);
});

test("Malaysia rollover refreshes the date window without clearing contacts", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-04T15:55:00Z") });
  await fixtures(page);
  await checkout(page);
  await page.locator('[data-view-target="booking-view"][data-preserve-booking]').first().click();
  await page.locator("#calendar-grid .calendar-day").first().click();
  await page.clock.setSystemTime(new Date("2026-10-04T16:05:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#pickup-date")).toHaveAttribute("min", "2026-10-05");
  await expect(page.locator("#pickup-date")).toHaveValue("2026-10-05");
  await expect(page.locator("#pickup-slot")).toHaveValue("");
  await expect(page.locator("#customer-name")).toHaveValue("Synthetic Customer");
});

test("submit joins an already running debounced quote instead of racing it", async ({ page }) => {
  const calls = await fixtures(page, { estimate: async (route) => { await pause(600); await route.fulfill({ json: quote() }); } });
  await checkout(page);
  await page.locator("#customer-phone").blur();
  await expect.poll(() => calls.estimates.length).toBe(1);
  await page.locator("#booking-form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.estimates).toHaveLength(1);
  expect(calls.bookings).toHaveLength(1);
});

test("details changed programmatically while awaiting the quote are not silently submitted", async ({ page }) => {
  const calls = await fixtures(page, { estimate: async (route) => { await pause(400); await route.fulfill({ json: quote() }); } });
  await checkout(page);
  await page.locator("#booking-form").evaluate((form) => form.requestSubmit());
  await page.locator("#customer-name").evaluate((input) => { input.value = "Changed Customer"; });
  await expect(page.locator("#form-error")).toContainText(/details changed/i);
  await expect(page.locator("#customer-name")).toHaveValue("Changed Customer");
  await expect(page.locator("#customer-name")).toBeEnabled();
  expect(calls.bookings).toHaveLength(0);
});

test("malformed successful quote is rejected without a booking POST", async ({ page }) => {
  const calls = await fixtures(page, { estimate: (route) => route.fulfill({ json: { ...quote(), total: 1 } }) });
  await checkout(page);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#form-error")).toContainText(/quote.*verified/i);
  expect(calls.bookings).toHaveLength(0);
});

test("ambiguous successful booking JSON protects the original request and reset requires acknowledgement", async ({ page }) => {
  const calls = await fixtures(page, { booking: (route, count) => count === 1 ? route.fulfill({ contentType: "application/json", body: "{" }) : route.fulfill({ json: { booking: record(), trackingToken: token } }) });
  await checkout(page);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#form-error")).toContainText("confirmation could not be verified");
  await page.locator("#booking-form").evaluate((form) => form.reset());
  await expect(page.locator("#customer-name")).toHaveValue("Synthetic Customer");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#booking-recovery-reset").click();
  await expect(page.locator("#customer-name")).toBeDisabled();
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.bookings[1]).toEqual(calls.bookings[0]);
});

test("config wait is bounded and a late response cannot reopen intake without retry", async ({ page }) => {
  await page.clock.install();
  let release;
  let requested = false;
  const gate = new Promise((resolve) => { release = resolve; });
  let delayed = true;
  await fixtures(page, { config: async (route) => {
    if (delayed) { requested = true; await gate; }
    await route.fulfill({ json: { bookingEnabled: true, turnstileSiteKey: "" } }).catch(() => {});
  } });
  await page.goto("/");
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator("#booking-entry-button")).toBeDisabled();
  await page.clock.fastForward(15001);
  await expect(page.locator("#booking-config-retry")).toBeVisible();
  delayed = false;
  release();
  await pause(100);
  await expect(page.locator("#booking-entry-button")).toBeDisabled();
  await page.locator("#booking-config-retry").click();
  await expect(page.locator("#booking-entry-button")).toBeEnabled();
});

test("lookup and all actions stay serialized while a reschedule is pending", async ({ page }) => {
  const calls = await fixtures(page, { mutation: async (route) => { await pause(600); await route.fulfill({ json: { booking: record() } }); } });
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  await page.locator('[data-customer-action="reschedule"]').click();
  await page.locator("#tracking-confirm-yes").evaluate((button) => { button.click(); button.click(); document.querySelector("#track-button").click(); });
  for (const selector of ["#track-button", "#tracking-token", "#tracking-action-phone", "#tracking-reschedule-date", '[data-customer-open="cancel"]']) await expect(page.locator(selector)).toBeDisabled();
  await expect.poll(() => calls.tracks.length).toBe(2);
  await expect(page.locator('[data-customer-open="reschedule"]')).toBeEnabled();
  expect(calls.actions).toHaveLength(1);
  expect(calls.actions[0].body).toMatchObject({ number, token });
});

test("captured record credentials, not unsent lookup edits, authorize a mutation", async ({ page }) => {
  const calls = await fixtures(page);
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  await page.locator("#tracking-token").evaluate((input) => { input.value = "different-token-without-input-event"; });
  await page.locator('[data-customer-action="reschedule"]').click();
  await page.locator("#tracking-confirm-yes").click();
  await expect.poll(() => calls.actions.length).toBe(1);
  expect(calls.actions[0].body.token).toBe(token);
  await expect(page.locator('[data-customer-open="reschedule"]')).toBeEnabled();
});

test("reschedule conflict refreshes choices without repeating the mutation", async ({ page }) => {
  let taken = false;
  const calls = await fixtures(page, {
    availability: (route, date) => route.fulfill({ json: { date, bookedSlots: taken ? ["20:00"] : [] } }),
    mutation: (route) => { taken = true; return route.fulfill({ status: 409, json: { error: "That pickup slot has just been taken" } }); },
  });
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  await page.locator("#tracking-reschedule-slot").selectOption("20:00");
  await page.locator('[data-customer-action="reschedule"]').click();
  await page.locator("#tracking-confirm-yes").click();
  await expect(page.locator("#tracking-action-error")).toContainText(/changed.*refreshed/i);
  await expect(page.locator('#tracking-reschedule-slot option[value="20:00"]')).toHaveCount(0);
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  await expect(page.locator("#tracking-action-phone")).toHaveValue("+60123456789");
  expect(calls.actions).toHaveLength(1);
});

test("late availability responses cannot replace choices for a newly selected date", async ({ page }) => {
  const original = getMaxBookingDateString();
  const previous = new Date(`${original}T12:00:00+08:00`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const other = previous.toISOString().slice(0, 10);
  const calls = await fixtures(page, { availability: async (route, date) => {
    await pause(date === other ? 600 : 80);
    await route.fulfill({ json: { date, bookedSlots: date === other ? ["20:00"] : ["21:00"] } }).catch(() => {});
  } });
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  await page.locator("#tracking-reschedule-date").fill(other);
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeDisabled();
  await page.locator("#tracking-reschedule-date").fill(original);
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  await pause(650);
  await expect(page.locator('#tracking-reschedule-slot option[value="20:00"]')).toHaveCount(1);
  await expect(page.locator('#tracking-reschedule-slot option[value="21:00"]')).toHaveCount(0);
  expect(calls.actions).toHaveLength(0);
});

test("closed same-day reschedule slots are omitted and rollover refreshes the chooser", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-04T12:50:00Z") });
  await fixtures(page);
  await lookup(page);
  await verifyPhone(page, "reschedule");
  await page.locator("#tracking-reschedule-date").fill("2026-10-04");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  expect(await page.locator("#tracking-reschedule-slot option").evaluateAll((options) => options.map((option) => option.value))).toEqual(["21:00"]);
  await page.clock.setSystemTime(new Date("2026-10-04T16:05:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#tracking-reschedule-date")).toHaveAttribute("min", "2026-10-05");
  await expect(page.locator("#tracking-reschedule-date")).toHaveValue("2026-10-05");
  await expect(page.locator('[data-customer-action="reschedule"]')).toBeEnabled();
  expect(await page.locator("#tracking-reschedule-slot option").evaluateAll((options) => options.map((option) => option.value))).toEqual(["19:00", "20:00", "21:00"]);
});

test("booking timeout restores same-booking retry without rotating its key or payload", async ({ page }) => {
  await page.clock.install();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = await fixtures(page, { booking: async (route, count) => {
    if (count === 1) await gate;
    await route.fulfill({ json: { booking: record(), trackingToken: token } }).catch(() => {});
  } });
  await checkout(page);
  await page.locator('#booking-form [type="submit"]').click();
  await expect.poll(() => calls.bookings.length).toBe(1);
  await page.clock.fastForward(15001);
  await expect(page.locator("#form-error")).toContainText("confirmation could not be verified");
  await expect(page.locator('#booking-form [type="submit"]')).toBeEnabled();
  await expect(page.locator("#customer-name")).toBeDisabled();
  release();
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.bookings[1]).toEqual(calls.bookings[0]);
});

test("tracking network failures remain retryable rather than implying an unknown booking", async ({ page }) => {
  let offline = true;
  await fixtures(page, { track: (route) => offline ? route.abort("failed") : route.fulfill({ json: record() }) });
  await page.goto("/track");
  await page.locator("#tracking-number").fill(number);
  await page.locator("#tracking-token").fill(token);
  await page.locator("#track-button").click();
  await expect(page.locator("#tracking-error")).toContainText(/retry/i);
  await expect(page.locator("#tracking-error")).not.toContainText("could not find");
  await expect(page.locator("#tracking-token")).toHaveValue(token);
  offline = false;
  await page.locator("#track-button").click();
  await expect(page.locator("#tracking-result h3")).toHaveText(number);
});

test("cancellation is serialized and terminal after success", async ({ page }) => {
  const calls = await fixtures(page, { mutation: async (route) => { await pause(400); await route.fulfill({ json: { booking: { ...record(), status: "Cancelled" } } }); } });
  await lookup(page);
  await page.locator('[data-customer-open="cancel"]').click();
  await page.locator("#tracking-action-phone").fill("+60123456789");
  await page.locator("#tracking-verify-continue").click();
  await page.locator("#tracking-confirm-yes").click();
  await expect(page.locator('[data-customer-open="reschedule"]')).toBeDisabled();
  await expect(page.locator("#track-button")).toBeDisabled();
  await expect(page.locator(".tracking-current-status")).toContainText("Cancelled");
  await expect(page.locator("[data-customer-action]")).toHaveCount(0);
  await expect(page.locator("#track-button")).toBeEnabled();
  expect(calls.actions).toHaveLength(1);
  expect(calls.tracks).toHaveLength(1);
});

test("customer edits booking details with live repricing from tracking", async ({ page }) => {
  const calls = await fixtures(page, {
    mutation: async (route) => {
      const body = route.request().postDataJSON();
      if (body.fields) {
        const size = Number(body.fields.packageSize);
        const serviceTotal = size === 18 ? 54.99 : 29.99;
        return route.fulfill({ json: { booking: editView({ packageSize: size, serviceTotal, total: serviceTotal, name: body.fields.name }) } });
      }
      return route.fulfill({ json: { booking: editView() } });
    },
  });
  await lookup(page);
  await verifyPhone(page, "edit");
  await expect(page.locator("#tracking-edit-name")).toHaveValue("Synthetic Customer");
  await expect(page.locator("#tracking-edit-block")).toHaveValue("Block A/B");
  await page.locator("#tracking-edit-package").selectOption("18");
  await expect(page.locator("#tracking-edit-total")).toContainText("RM54.99");
  await expect(page.locator("#tracking-edit-total")).toContainText("was RM29.99");
  await page.locator("#tracking-edit-name").fill("Renamed Customer");
  await page.locator('[data-customer-action="edit"]').click();
  await page.locator("#tracking-confirm-yes").click();
  await expect(() => {
    expect(calls.actions).toHaveLength(2);
    expect(calls.tracks).toHaveLength(2);
  }).toPass();
  expect(calls.actions[0].body.fields).toBeUndefined();
  const save = calls.actions[1].body;
  expect(save.phone).toBe("+60123456789");
  expect(save.fields.name).toBe("Renamed Customer");
  expect(save.fields.packageSize).toBe(18);
  expect(save.fields).not.toHaveProperty("phone");
  expect(save.fields).not.toHaveProperty("pickupDate");
});

test("customer edit load keeps the form closed for ineligible bookings", async ({ page }) => {
  await fixtures(page, {
    mutation: async (route) => route.fulfill({ json: { booking: editView({ canEdit: false, editLate: true }) } }),
  });
  await lookup(page);
  await verifyPhone(page, "edit");
  await expect(page.locator("#tracking-action-error")).toContainText(/pickup is about to start|can no longer be edited/i);
  await expect(page.locator("#tracking-edit-panel")).toBeHidden();
});

for (const width of [320, 480]) {
  test(`recovery controls fit a ${width}px viewport with accessible tap targets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const calls = await fixtures(page, { booking: (route) => route.abort("failed") });
    await checkout(page);
    await page.locator('#booking-form [type="submit"]').click();
    await expect(page.locator("#booking-recovery-reset")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const selector of ['#booking-form [type="submit"]', "#booking-recovery-reset"]) {
      const box = await page.locator(selector).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(calls.bookings).toHaveLength(1);
  });
}

test("editing after an ambiguous booking requires accepting the saved-booking risk", async ({ page }) => {
  const calls = await fixtures(page, { booking: (route, count) => count === 1 ? route.abort("failed") : route.fulfill({ json: { booking: record(), trackingToken: token } }) });
  await checkout(page);
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#booking-recovery-reset")).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("may already be saved");
    await dialog.accept();
  });
  await page.locator("#booking-recovery-reset").click();
  await expect(page.locator("#customer-name")).toBeEnabled();
  await expect(page.locator("#form-error")).toContainText("acknowledged");
  await page.locator("#customer-name").fill("Acknowledged New Customer");
  await expect(page.locator(".slot-button.open").first()).toBeAttached();
  await page.locator('#booking-form [type="submit"]').click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(calls.bookings[1].key).not.toBe(calls.bookings[0].key);
  expect(calls.bookings[1].body.name).toBe("Acknowledged New Customer");
});
