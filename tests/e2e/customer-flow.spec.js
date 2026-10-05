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

test("customer booking, tracking, idempotency, and cancellation stay isolated", async ({ page }) => {
  await page.goto("/");
  const config = await apiFetch(page, "/api/config", { method: "GET", headers: {} });
  expect(config.status).toBe(200);
  expect(config.body.bookingEnabled).toBe(true);

  let pickupDate = "";
  let pickupSlot = "";
  for (let offset = 1; offset <= 6 && !pickupSlot; offset += 1) {
    const candidateDate = dateAfter(offset);
    const availability = await apiFetch(page, `/api/availability?date=${candidateDate}`, { method: "GET", headers: {} });
    const booked = new Set(availability.body.bookedSlots || []);
    const free = slotsForDate(candidateDate).find((slot) => !booked.has(slot));
    if (free) {
      pickupDate = candidateDate;
      pickupSlot = free;
    }
  }
  test.skip(!pickupSlot, "The local test database has no free pickup slot");

  const unique = String(Date.now()).slice(-8);
  const payload = {
    name: "Playwright Smoke",
    phone: `+601${unique}`,
    block: "Block A/B",
    unit: "A-8-02",
    packageSize: 10,
    service: "standard",
    hangers: false,
    pickupDate,
    pickupSlot,
    paymentMethod: "cash",
    termsAccepted: true,
  };
  const key = `playwright-${Date.now()}`;
  const created = await apiFetch(page, "/api/bookings", {
    method: "POST",
    headers: { "X-Idempotency-Key": key },
    body: JSON.stringify(payload),
  });
  expect(created.status).toBe(201);
  expect(created.body.booking.status).toBe("Confirmed");
  expect(created.body.booking.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(created.body.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const replay = await apiFetch(page, "/api/bookings", {
    method: "POST",
    headers: { "X-Idempotency-Key": key },
    body: JSON.stringify(payload),
  });
  expect(replay.status).toBe(201);
  expect(replay.body.booking.number).toBe(created.body.booking.number);

  const tracked = await apiFetch(page, "/api/track", {
    method: "POST",
    body: JSON.stringify({ number: created.body.booking.number, token: created.body.trackingToken }),
  });
  expect(tracked.status).toBe(200);
  expect(tracked.body.number).toBe(created.body.booking.number);
  expect(tracked.body).not.toHaveProperty("name");
  expect(tracked.body).not.toHaveProperty("phone");
  expect(tracked.body).not.toHaveProperty("block");
  expect(tracked.body.canCancel).toBe(true);

  const cancelled = await apiFetch(page, `/api/bookings/${created.body.booking.number}/cancel`, {
    method: "POST",
    body: JSON.stringify({ number: created.body.booking.number, token: created.body.trackingToken, phone: payload.phone }),
  });
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.booking.status).toBe("Cancelled");
});

test("local D1 concurrent retries recover one booking and competing customers cannot double-book", async ({ page }) => {
  await page.goto("/");
  let pickupDate;
  let pickupSlot;
  for (let offset = 1; offset <= 6 && !pickupSlot; offset += 1) {
    const date = dateAfter(offset);
    const result = await apiFetch(page, `/api/availability?date=${date}`, { method: "GET" });
    const occupied = new Set(result.body.bookedSlots || []);
    pickupSlot = slotsForDate(date).find((slot) => !occupied.has(slot));
    if (pickupSlot) pickupDate = date;
  }
  test.skip(!pickupSlot, "The local test database has no free slot");
  const payload = {
    name: "Concurrent Synthetic", phone: `+601${String(Date.now()).slice(-8)}`, block: "Block A/B", unit: "A-8-02",
    packageSize: 10, service: "standard", hangers: false, pickupDate, pickupSlot, paymentMethod: "cash", termsAccepted: true,
  };
  const key = `concurrent-${crypto.randomUUID()}`;
  const [first, retry] = await Promise.all([0, 1].map(() => apiFetch(page, "/api/bookings", {
    method: "POST", headers: { "X-Idempotency-Key": key }, body: JSON.stringify(payload),
  })));
  expect(first.status).toBe(201);
  expect(retry.status).toBe(201);
  expect(first.body.booking.number === retry.body.booking.number).toBe(true);
  expect(first.body.trackingToken === retry.body.trackingToken).toBe(true);
  const conflict = await apiFetch(page, "/api/bookings", {
    method: "POST", headers: { "X-Idempotency-Key": `competing-${crypto.randomUUID()}` },
    body: JSON.stringify({ ...payload, phone: `+602${String(Date.now()).slice(-8)}` }),
  });
  expect(conflict.status).toBe(409);
  const cancelled = await apiFetch(page, `/api/bookings/${first.body.booking.number}/cancel`, {
    method: "POST", body: JSON.stringify({ number: first.body.booking.number, token: first.body.trackingToken, phone: payload.phone }),
  });
  expect(cancelled.status).toBe(200);
  const competitors = [1, 2].map((index) => ({ ...payload, phone: `+60${index + 2}${String(Date.now()).slice(-8)}` }));
  const reservations = await Promise.all(competitors.map((candidate) => apiFetch(page, "/api/bookings", {
    method: "POST", headers: { "X-Idempotency-Key": `different-customer-${crypto.randomUUID()}` }, body: JSON.stringify(candidate),
  })));
  expect(reservations.map((result) => result.status).sort()).toEqual([201, 409]);
  const winnerIndex = reservations.findIndex((result) => result.status === 201);
  const winner = reservations[winnerIndex].body;
  const released = await apiFetch(page, `/api/bookings/${winner.booking.number}/cancel`, {
    method: "POST", body: JSON.stringify({ number: winner.booking.number, token: winner.trackingToken, phone: competitors[winnerIndex].phone }),
  });
  expect(released.status).toBe(200);
});

test("local D1 operator search and pagination work beyond the initial page", async ({ page }) => {
  await page.goto("http://ops.localhost:8787");
  const search = (body) => apiFetch(page, "/api/operator/bookings/search", {
    method: "POST",
    headers: { "X-Local-Operator-Email": "local.operator@example.invalid" },
    body: JSON.stringify(body),
  });
  const first = await search({ status: "all", query: "", date: "", limit: 1, offset: 0 });
  expect(first.status).toBe(200);
  expect(first.body.page.limit).toBe(1);
  expect(first.body.bookings.length).toBeLessThanOrEqual(1);
  if (first.body.page.total > 1) {
    const second = await search({ status: "all", query: "", date: "", limit: 1, offset: 1 });
    expect(second.status).toBe(200);
    expect(second.body.page.total).toBe(first.body.page.total);
    expect(second.body.bookings[0].id === first.body.bookings[0].id).toBe(false);
  }
  const synthetic = await search({ query: "Playwright Smoke", status: "cancelled", limit: 25, offset: 0 });
  expect(synthetic.status).toBe(200);
  expect(synthetic.body.page.total).toBeGreaterThan(0);
  expect(synthetic.body.bookings.every((booking) => booking.status === "Cancelled")).toBe(true);
  const literal = await search({ query: "% OR 1=1 --", limit: 25, offset: 0 });
  expect(literal.status).toBe(200);
  expect(literal.body.page.total).toBe(0);
});
