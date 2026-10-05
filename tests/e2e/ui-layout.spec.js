import { expect, test } from "@playwright/test";
import { getMaxBookingDateString } from "../../public/shared/utils.js";

const operatorURL = "http://ops.localhost:8787";
const sampleBooking = {
  id: "00000000-0000-4000-8000-000000000001",
  number: "LL-AB12CD34",
  name: "UI Test Customer",
  phone: "+60123456789",
  block: "Block A/B",
  unit: "A-8-02",
  packageSize: 10,
  service: "standard",
  folding: true,
  ironing: true,
  hangers: false,
  pickupDate: getMaxBookingDateString(),
  pickupSlot: "19:00",
  readyTime: "Next day · MYT",
  status: "Confirmed",
  paymentMethod: "cash",
  paymentStatus: "unpaid",
  serviceTotal: 29.99,
  feeTotal: 0,
  total: 29.99,
  revision: 1,
  notes: [],
  penalties: [],
  events: [],
};

async function mockOperatorAPI(page, { conflict = false } = {}) {
  let booking = structuredClone(sampleBooking);
  const calls = [];
  await page.route("**/api/operator/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/export")) {
      await route.fulfill({ contentType: "text/csv; charset=utf-8", body: '"Booking number"\r\n"LL-AB12CD34"\r\n' });
    } else if (path.endsWith("/search")) {
      const { query = "", status = "all", offset = 0, limit = 25 } = request.postDataJSON();
      const matches = (!query || `${booking.name} ${booking.number}`.toLowerCase().includes(query.toLowerCase()))
        && (status === "all" || status === "pending" && booking.status === "Confirmed" || status === "completed" && booking.status === "Delivered" || status === "cancelled" && booking.status === "Cancelled");
      await route.fulfill({ json: { bookings: matches ? [booking] : [], page: { offset, limit, total: matches ? 1 : 0, hasMore: false }, summary: {
        pending: booking.status === "Confirmed" ? 1 : 0, active: 0,
        unpaid: booking.status !== "Cancelled" && booking.paymentStatus === "unpaid" ? 1 : 0,
        collected: booking.paymentStatus === "paid" ? 29.99 : 0,
      } } });
    } else if (request.method() === "GET") {
      await route.fulfill({ json: path.endsWith(booking.id) ? { booking } : { bookings: [booking] } });
    } else {
      const body = request.postDataJSON();
      calls.push({ path, body });
      if (request.method() === "PATCH" && conflict) {
        await route.fulfill({ status: 409, json: { error: "Booking changed; refresh the order." } });
        return;
      }
      if (request.method() === "PATCH") {
        if (body.action === "paid") booking.paymentStatus = "paid";
        if (body.action === "cancel") booking.status = "Cancelled";
        if (body.action === "advance") booking.status = "Pickup on the way";
        if (body.action === "edit" && body.fields) {
          Object.assign(booking, body.fields);
          if (body.fields.packageSize === 18) { booking.serviceTotal = 54.99; booking.total = 54.99; }
        }
        booking.revision += 1;
      }
      if (path.endsWith("/notes")) booking.notes.unshift({ id: "note-ui", note: body.note, at: "2026-10-01T12:00:00Z", actor: "Test operator" });
      await route.fulfill({ json: path.endsWith("/share")
        ? { trackingLink: `http://localhost:8787/track#number=${booking.number}&token=${"p".repeat(43)}` }
        : { booking } });
    }
  });
  return calls;
}

async function mockCustomerAPI(page) {
  await page.route("**/api/config", (route) => route.fulfill({ json: { bookingEnabled: true, turnstileSiteKey: "" } }));
  await page.route("**/api/availability?*", (route) => route.fulfill({
    json: { date: new URL(route.request().url()).searchParams.get("date"), bookedSlots: [] },
  }));
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const browserErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && /\.(js|css)$/.test(path)) errors.push(`Missing UI asset: ${path}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

for (const width of [320, 390, 480]) {
  test(`customer screens fit a ${width}px mobile viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await mockCustomerAPI(page);
    await page.goto("/");
    await expect(page.locator("#home-view h1")).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("customer-home.png"), fullPage: true, animations: "disabled" });
    await page.locator("#booking-entry-button").click();
    await expect(page.locator("#calendar-grid .calendar-day")).toHaveCount(7);
    await page.locator("#calendar-grid .calendar-day").last().click();
    await expect(page.locator(".slot-button.open").first()).toBeVisible();
    await expectNoOverflow(page);
    await page.locator(".slot-button.open").first().click();
    await page.locator("#checkout-button").click();
    await expect(page.locator("#checkout-view")).toBeVisible();
    await expectNoOverflow(page);
    expect(await page.locator("#customer-name").evaluate((input) => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: testInfo.outputPath("customer-checkout.png"), fullPage: true, animations: "disabled" });
  });
}

test("customer weekend picker includes morning as well as evening slots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCustomerAPI(page);
  await page.goto("/");
  await page.locator("#booking-entry-button").click();
  await page.locator("#calendar-grid .calendar-day.weekend").last().click();
  await expect(page.locator(".slot-button")).toHaveCount(6);
  await expect(page.locator('[data-slot="10:00"] strong')).toHaveText(/^10:00\s?AM$/);
  await expect(page.locator('[data-slot="19:00"] strong')).toHaveText(/^7:00\s?PM$/);
});

test("customer stays phone-width on a desktop preview", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockCustomerAPI(page);
  await page.goto("/");
  const shell = await page.locator(".app-shell").boundingBox();
  expect(shell.width).toBeLessThanOrEqual(520);
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("customer-home.png"), fullPage: true, animations: "disabled" });
});

test("operator uses a desktop workspace instead of a phone shell", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/operator/bookings/search", (route) => route.fulfill({
    json: { bookings: [], page: { offset: 0, limit: 25, total: 0, hasMore: false }, summary: { pending: 0, active: 0, unpaid: 0, collected: 0 } },
  }));
  await page.goto(operatorURL);
  await expect(page.locator("#operator-empty")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("operator-queue.png"), fullPage: true, animations: "disabled" });
  const shell = await page.locator(".operator-shell").boundingBox();
  expect(shell.width).toBeGreaterThan(1000);
  await expectNoOverflow(page);
});

test("operator shows a small-screen guard without fetching customer records", async ({ page }) => {
  let requests = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/operator/**", (route) => {
    requests += 1;
    return route.fulfill({ json: { bookings: [], summary: { pending: 0, active: 0, unpaid: 0, collected: 0 }, page: { offset: 0, limit: 25, total: 0, hasMore: false } } });
  });
  await page.goto(operatorURL);
  await expect(page.locator("#desktop-required-title")).toBeVisible();
  await expect(page.locator("#operator-view")).not.toBeVisible();
  expect(requests).toBe(0);
  await expectNoOverflow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#operator-empty")).toBeVisible();
  expect(requests).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#desktop-required-title")).toBeVisible();
  await expect(page.locator("#operator-booking-list")).toBeEmpty();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#operator-empty")).toBeVisible();
  expect(requests).toBe(2);
});

for (const width of [1024, 1280, 1920]) {
  test(`operator card grid and drawer fit a ${width}px desktop viewport`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await mockOperatorAPI(page);
    await page.goto(operatorURL);
    await page.locator("[data-booking-id]").click();
    await expect(page.locator("#operator-detail-title")).toHaveText(sampleBooking.name);
    await expect(page.locator("#operator-drawer")).toBeVisible();
    await expect(page.locator("[data-booking-id]")).toBeVisible();
    await expect(page.locator("[data-operator-action=advance]")).toBeEnabled();
    const drawer = await page.locator("#operator-drawer").boundingBox();
    expect(drawer.x).toBeGreaterThan(width * 0.4);
    expect(drawer.x + drawer.width).toBeGreaterThanOrEqual(width - 1);
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("operator-detail.png"), fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
  });
}

test("operator search, filter, payment, notes, private share and export use real controls", async ({ page }) => {
  const calls = await mockOperatorAPI(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(operatorURL);
  await expect(page.locator("#operator-pending-count")).toHaveText("1");
  await page.locator("#operator-search").fill("not-a-match");
  await expect(page.locator("#operator-empty")).toBeVisible();
  await page.locator("#operator-search").fill("ui test");
  await expect(page.locator("[data-booking-id]")).toHaveCount(1);
  await page.locator("#operator-filter").selectOption("completed");
  await expect(page.locator("#operator-empty")).toBeVisible();
  await page.locator("#operator-filter").selectOption("all");
  await page.locator("[data-booking-id]").click();
  await page.locator("[data-operator-action=paid]").click();
  await expect(page.getByRole("dialog", { name: "Confirm payment collected" })).toBeVisible();
  await page.getByRole("button", { name: "Keep unchanged" }).click();
  expect(calls).toHaveLength(0);
  await page.locator("[data-operator-action=paid]").click();
  await page.getByRole("button", { name: "Record collection", exact: true }).click();
  await expect(page.locator("#operator-collected-total")).toHaveText("RM29.99");
  expect(calls[0].body).toMatchObject({ action: "paid", revision: 1 });
  const plainNote = "<img src=x onerror=alert(1)> Keep this plain text.";
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.locator('[data-section="notes"] > summary').click();
  await page.locator("#operator-note-input").fill(plainNote);
  await page.locator("[data-operator-note]").click();
  await expect(page.locator("#operator-detail")).toContainText(plainNote);
  expect(await page.locator("#operator-detail img").count()).toBe(0);
  await page.locator('[data-section="tracking"] > summary').click();
  await page.locator("[data-operator-tracking-action=share]").click();
  await page.getByRole("button", { name: "Show link", exact: true }).click();
  await expect(page.locator("#operator-tracking-link")).toHaveValue(/\/track#number=LL-AB12CD34&token=/);
  await page.locator("#operator-drawer-refresh").click();
  await expect(page.locator("#operator-tracking-output")).toBeHidden();
  await expect(page.locator("#operator-tracking-link")).toHaveValue("");
  await page.locator("#operator-back-list").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#operator-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lazy-laundry-bookings.csv");
});

test("operator cancellation dialog requires a reason and Escape keeps the order unchanged", async ({ page }) => {
  const calls = await mockOperatorAPI(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(operatorURL);
  await page.locator("[data-booking-id]").click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.locator('[data-section="exceptions"] > summary').click();
  await page.locator("[data-operator-action=cancel]").click();
  await page.locator(".operator-dialog").getByRole("button", { name: "Cancel booking", exact: true }).click();
  await expect(page.locator("#operator-dialog-error")).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".operator-dialog")).toHaveCount(0);
  await expect(page.locator("[data-operator-action=cancel]")).toBeFocused();
  await page.locator("[data-operator-action=cancel]").click();
  await page.locator("#operator-dialog-reason").fill("  Customer requested cancellation  ");
  await page.locator(".operator-dialog").getByRole("button", { name: "Cancel booking", exact: true }).click();
  await expect(page.locator("[data-operator-action=reopen]")).toBeVisible();
  expect(calls[0].body.reason).toBe("Customer requested cancellation");
});

test("operator baseline is compact and searches and pages across the full database", async ({ page }, testInfo) => {
  const requests = [];
  const records = Array.from({ length: 60 }, (_, index) => ({
    ...sampleBooking, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    number: `LL-${index.toString(16).toUpperCase().padStart(8, "0")}`, name: `Synthetic customer ${index + 1}`,
  }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/operator/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/search")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      const matching = records.filter((record) => !body.query || `${record.name} ${record.number}`.toLowerCase().includes(body.query.toLowerCase()));
      await route.fulfill({ json: { bookings: matching.slice(body.offset, body.offset + body.limit),
        page: { offset: body.offset, limit: body.limit, total: matching.length, hasMore: body.offset + body.limit < matching.length },
        summary: { pending: 60, active: 0, unpaid: 60, collected: 0 },
      } });
    } else {
      await route.fulfill({ json: { booking: records.find((record) => path.endsWith(record.id)) } });
    }
  });
  await page.goto(operatorURL);
  await expect(page.locator("[data-booking-id]")).toHaveCount(10);
  await page.locator("[data-booking-id]").first().click();
  await expect(page.locator("#operator-detail-title")).toHaveText("Synthetic customer 1");
  for (const selector of ["[data-operator-action=advance]", "[data-operator-action=paid]"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(800);
  }
  await expect(page.locator("[data-operator-tracking-action=share]")).toBeHidden();
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("compact-operator.png"), fullPage: true, animations: "disabled" });
  await page.locator("#operator-back-list").click();
  await expect(page.locator("#operator-drawer")).not.toBeVisible();
  await page.locator("#operator-next").click();
  await expect(page.locator("#operator-page-info")).toContainText("11");
  await page.locator("#operator-next").click();
  await expect(page.locator("[data-booking-id]")).toHaveCount(10);
  await page.locator("#operator-search").fill("Synthetic customer 60");
  await expect(page.locator("[data-booking-id]")).toHaveCount(1);
  await expect(page.locator(".operator-order-card")).toContainText("Synthetic customer 60");
  expect(requests.at(-1)).toMatchObject({ query: "Synthetic customer 60", offset: 0 });
  expect(page.url()).not.toContain("customer");
});

test("operator same-order refresh preserves drafts and changing orders requires acknowledgement", async ({ page }) => {
  const calls = await mockOperatorAPI(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(operatorURL);
  await page.locator("[data-booking-id]").click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.locator('[data-section="notes"] > summary').click();
  await page.locator("#operator-note-input").fill("Unsaved pickup instruction");
  await page.locator("#operator-drawer-refresh").click();
  await expect(page.locator("#operator-note-input")).toHaveValue("Unsaved pickup instruction");
  await expect(page.locator('[data-section="notes"]')).toHaveAttribute("open", "");
  await page.locator("#operator-back-list").click();
  await expect(page.getByRole("dialog", { name: "Discard unsaved note?" })).toBeVisible();
  await page.getByRole("button", { name: /Keep (editing|unchanged)/i }).click();
  await expect(page.locator("#operator-note-input")).toHaveValue("Unsaved pickup instruction");
  expect(calls).toHaveLength(0);
});

test("operator ambiguous mutation locks writes until authoritative refresh without repeating payment", async ({ page }) => {
  await mockOperatorAPI(page);
  let serverPaid = false;
  let writes = 0;
  await page.route(`**/api/operator/bookings/${sampleBooking.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      writes += 1;
      serverPaid = true;
      await route.abort("failed");
    } else {
      await route.fulfill({ json: { booking: { ...sampleBooking, paymentStatus: serverPaid ? "paid" : "unpaid" } } });
    }
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(operatorURL);
  await page.locator("[data-booking-id]").click();
  await page.locator("[data-operator-action=paid]").click();
  await page.getByRole("dialog").getByRole("button", { name: "Record collection", exact: true }).click();
  await expect(page.locator("#operator-feedback")).toContainText(/outcome is unknown/i);
  await expect(page.locator("[data-operator-action=paid]")).toBeDisabled();
  expect(writes).toBe(1);
  await page.locator("#operator-detail-retry").click();
  await expect(page.locator("[data-operator-action=paid]")).toHaveCount(0);
  await expect(page.locator("[data-operator-action=advance]")).toBeEnabled();
  expect(writes).toBe(1);
});

test("operator detail load failure has working inline retry and restores actions", async ({ page }) => {
  await mockOperatorAPI(page);
  let fails = true;
  await page.route(`**/api/operator/bookings/${sampleBooking.id}`, (route) => fails
    ? route.fulfill({ status: 503, json: { error: "Synthetic unavailable order" } })
    : route.fallback());
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(operatorURL);
  await page.locator("[data-booking-id]").click();
  await expect(page.locator("#operator-detail-retry")).toBeVisible();
  fails = false;
  await page.locator("#operator-detail-retry").click();
  await expect(page.locator("#operator-detail-title")).toHaveText(sampleBooking.name);
  await expect(page.locator("[data-operator-action=advance]")).toBeEnabled();
});

test("operator milestone uses five full-width cards per row and ten orders per page", async ({ page }, testInfo) => {
  const requests = [];
  const records = Array.from({ length: 30 }, (_, index) => ({
    ...sampleBooking, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    number: `LL-${index.toString(16).toUpperCase().padStart(8, "0")}`, name: `Customer ${index + 1}`,
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/operator/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/search")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      return route.fulfill({ json: { bookings: records.slice(body.offset, body.offset + body.limit),
        page: { offset: body.offset, limit: body.limit, total: records.length, hasMore: body.offset + body.limit < records.length },
        summary: { pending: 30, active: 0, unpaid: 30, collected: 0 },
      } });
    }
    return route.fulfill({ json: { booking: records.find((record) => route.request().url().endsWith(record.id)) } });
  });
  await page.goto(operatorURL);
  await expect(page.locator("[data-booking-id]")).toHaveCount(10);
  expect(requests[0].limit).toBe(10);
  const boxes = await page.locator(".operator-order-card").evaluateAll((cards) => cards.map((card) => {
    const { x, y, width, height } = card.getBoundingClientRect();
    return { x, y, width, height };
  }));
  expect(boxes.slice(0, 5).every((box) => Math.abs(box.y - boxes[0].y) < 1)).toBe(true);
  expect(boxes[5].y).toBeGreaterThan(boxes[0].y);
  expect(boxes[4].x + boxes[4].width).toBeGreaterThan(1400);
  const pickupClipped = await page.locator(".operator-card-pickup").evaluateAll((nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth));
  expect(pickupClipped).toBe(false);
  await expect(page.locator("#operator-drawer")).not.toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("operator-five-card-grid.png"), animations: "disabled", fullPage: true });
  await page.locator("#operator-next").click();
  await expect(page.locator("#operator-page-info")).toContainText("11");
  const opener = page.locator("[data-booking-id]").first();
  await opener.click();
  await expect(page.locator("#operator-drawer")).toBeVisible();
  await expect(page.locator("#operator-detail-title")).toHaveText("Customer 11");
  await page.screenshot({ path: testInfo.outputPath("operator-order-drawer.png"), animations: "disabled", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.locator("#operator-drawer")).not.toBeVisible();
  await expect(page.locator("#operator-page-info")).toContainText("11");
  await expect(page.locator("[data-booking-id]").first()).toBeFocused();
  expect(requests.at(-1).offset).toBe(10);
});

test("operator drawer tabs trap focus, retain drafts and protect closing", async ({ page }) => {
  const calls = await mockOperatorAPI(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(operatorURL);
  await page.locator("[data-booking-id]").click();
  await expect(page.getByRole("dialog", { name: "Order workspace" })).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.locator('[data-section="notes"] > summary').click();
  await page.locator("#operator-note-input").fill("Keep this draft during visual review");
  await page.getByRole("tab", { name: "Booking" }).click();
  await expect(page.locator("#operator-note-input")).not.toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.locator("#operator-note-input")).toHaveValue("Keep this draft during visual review");
  await page.locator("#operator-back-list").click();
  await expect(page.getByRole("dialog", { name: "Discard unsaved note?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.locator(".operator-dialog")).toHaveCount(0);
  await expect(page.locator("#operator-back-list")).toBeEnabled();
  await expect(page.locator("#operator-note-input")).toHaveValue("Keep this draft during visual review");
  await page.getByRole("tab", { name: "Activity" }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Overview" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement.closest("#operator-drawer")))).toBe(true);
  expect(calls).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#operator-drawer")).not.toBeVisible();
  await expect(page.locator("#operator-detail")).not.toContainText("Keep this draft");
});

test("operator booking edit reprices, reschedules and audits from the drawer", async ({ page }) => {
  const calls = await mockOperatorAPI(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(operatorURL);
  await page.locator(`[data-booking-edit="${sampleBooking.id}"]`).click();
  const drawer = page.getByRole("dialog", { name: "Order workspace" });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole("tab", { name: "Booking" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#operator-edit-name")).toHaveValue(sampleBooking.name);
  await page.locator("#operator-edit-name").fill("Renamed Customer");
  await page.locator("#operator-edit-package").selectOption("18");
  await page.locator("#operator-edit-save").click();
  await expect(page.locator("#operator-edit-error")).toContainText("audit reason");
  await page.locator("#operator-edit-reason").fill("Customer called to correct the order");
  await page.locator("#operator-edit-save").click();
  const confirm = page.getByRole("dialog", { name: "Save booking changes?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Package: 10 pieces → 18 pieces");
  await confirm.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => calls.some((call) => call.body.action === "edit")).toBe(true);
  const editCall = calls.find((call) => call.body.action === "edit");
  expect(editCall.body.revision).toBe(sampleBooking.revision);
  expect(editCall.body.reason).toBe("Customer called to correct the order");
  expect(editCall.body.fields.name).toBe("Renamed Customer");
  expect(editCall.body.fields.packageSize).toBe(18);
  await expect(page.locator("#operator-detail-title")).toHaveText("Renamed Customer");
  await expect(page.locator(".operator-order-card", { hasText: "Renamed Customer" })).toHaveCount(1);
});

test("customer completes the mobile form and can track the confirmation in memory", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCustomerAPI(page);
  let submitted;
  await page.route("**/api/estimate", (route) => route.fulfill({ json: {
    revision: "launch-v1", total: 29.99, lines: [{ label: "10-piece Lazy Wash", amount: 29.99 }],
  } }));
  await page.route("**/api/bookings", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { booking: sampleBooking, trackingToken: "p".repeat(43) } });
  });
  await page.route("**/api/track", (route) => route.fulfill({ json: {
    number: sampleBooking.number, pickupDate: sampleBooking.pickupDate, pickupSlot: sampleBooking.pickupSlot,
    readyTime: sampleBooking.readyTime, total: sampleBooking.total, status: "Confirmed",
    canCancel: true, canReschedule: true, cancellationLate: false,
  } }));
  await page.goto("/");
  await page.locator("#booking-entry-button").click();
  await page.locator("#calendar-grid .calendar-day").last().click();
  await page.locator(".slot-button.open").first().click();
  await page.screenshot({ path: testInfo.outputPath("customer-booking.png"), fullPage: true, animations: "disabled" });
  await page.locator("#checkout-button").click();
  await page.locator("#customer-name").fill("UI Test Customer");
  await page.locator("#customer-phone").fill("123456789");
  await page.locator("#customer-block").selectOption("Block A/B");
  await page.locator("#customer-unit").fill("A-8-02");
  await page.locator(".terms-row").click();
  await page.locator(".submit-button").click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  await expect(page.locator("#confirmation-tracking-token")).toHaveValue(/\/track#number=LL-AB12CD34&token=/);
  expect(submitted).toMatchObject({ phone: "+60123456789", termsAccepted: true, priceRevision: "launch-v1", expectedTotalCents: 2999 });
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("customer-confirmation.png"), fullPage: true, animations: "disabled" });
  await page.locator('#confirmation-view [data-view-target="tracking-view"]').click();
  await expect(page.locator("#tracking-number")).toHaveValue(sampleBooking.number);
  await page.locator("#track-button").click();
  await expect(page.locator("#tracking-result")).toContainText(sampleBooking.number);
  await expect(page.locator("#tracking-result")).not.toContainText(sampleBooking.name);
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("customer-tracking.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("a newly loaded quote with fees requires review before the first booking POST", async ({ page }) => {
  await mockCustomerAPI(page);
  let writes = 0;
  await page.route("**/api/estimate", (route) => route.fulfill({ json: {
    revision: "launch-v1", total: 32.99, lines: [{ label: "Laundry service", amount: 29.99 }, { label: "Outstanding service fee", amount: 3 }],
  } }));
  await page.route("**/api/bookings", (route) => {
    writes += 1;
    return route.fulfill({ status: 201, json: { booking: { ...sampleBooking, total: 32.99 }, trackingToken: "p".repeat(43) } });
  });
  await page.goto("/");
  await page.locator("#booking-entry-button").click();
  await page.locator("#calendar-grid .calendar-day").last().click();
  await page.locator(".slot-button.open").first().click();
  await page.locator("#checkout-button").click();
  await page.locator("#customer-name").fill("Synthetic customer");
  await page.locator("#customer-block").selectOption("Block A/B");
  await page.locator("#customer-unit").fill("A-8-02");
  await page.locator(".terms-row").click();
  await page.locator("#customer-phone").fill("123456789");
  await page.locator("#booking-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#form-error")).toContainText(/review/i);
  await expect(page.locator("#checkout-total-price")).toHaveText("RM32.99");
  expect(writes).toBe(0);
  await page.locator(".submit-button").click();
  await expect(page.locator("#confirmation-view")).toBeVisible();
  expect(writes).toBe(1);
});

test("customer tracking route works directly and captures fragment credentials without retaining the URL", async ({ page }) => {
  await mockCustomerAPI(page);
  await page.goto("/track");
  await expect(page.locator("#tracking-view")).toBeVisible();
  await page.goto(`/track#number=${sampleBooking.number}&token=${"p".repeat(43)}`);
  await expect(page.locator("#tracking-number")).toHaveValue(sampleBooking.number);
  await expect(page.locator("#tracking-token")).toHaveValue("p".repeat(43));
  await expect(page).toHaveURL(/\/track$/);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("customer paused intake and availability retry remain usable", async ({ page }) => {
  await mockCustomerAPI(page);
  await page.route("**/api/config", (route) => route.fulfill({ json: { bookingEnabled: false, turnstileSiteKey: "" } }));
  await page.goto("/");
  await expect(page.locator("#booking-entry-button")).toBeDisabled();
  await expect(page.locator("#booking-state-message")).toContainText("paused");
  await page.getByRole("button", { name: "Track an order" }).click();
  await expect(page.locator("#tracking-view")).toBeVisible();
  await page.unroute("**/api/config");
  await page.route("**/api/config", (route) => route.fulfill({ json: { bookingEnabled: true, turnstileSiteKey: "" } }));
  let availabilityFails = true;
  await page.route("**/api/availability?*", (route) => availabilityFails
    ? route.fulfill({ status: 503, json: { error: "Availability temporarily unavailable" } })
    : route.fulfill({ json: { date: new URL(route.request().url()).searchParams.get("date"), bookedSlots: [] } }));
  await page.goto("/");
  await page.locator("#booking-entry-button").click();
  await expect(page.getByRole("button", { name: "Retry availability" })).toBeVisible();
  availabilityFails = false;
  await page.getByRole("button", { name: "Retry availability" }).click();
  await expect(page.locator(".slot-button").first()).toBeVisible();
});

test("operator stale-update conflict disables mutations until refresh", async ({ page }) => {
  await mockOperatorAPI(page, { conflict: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(operatorURL);
  await page.locator("[data-booking-id]").click();
  await page.locator("[data-operator-action=advance]").click();
  await page.getByRole("dialog").getByRole("button", { name: "Update status", exact: true }).click();
  await expect(page.locator("#operator-feedback")).toContainText(/refresh/i);
  await expect(page.locator("[data-operator-action=advance]")).toBeDisabled();
  await page.locator("#operator-drawer-refresh").click();
  await expect(page.locator("[data-operator-action=advance]")).toBeEnabled();
});
