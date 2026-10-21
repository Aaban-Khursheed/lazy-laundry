// Real-D1 SQL/transaction evidence: the app fetch handler (api/worker.js
// default export) is executed in Node against the isolated harness's real D1
// binding. Deterministic interleavings are injected by wrapping env.DB so that
// ONLY batch() runs a supplied hook just before delegating — this models a
// write that lands between a request's pre-checks and its guarded transaction.
// This is real-D1 SQL/transaction evidence with Node handler execution, not
// full in-isolate behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../api/worker.js";
import { startHarness } from "../runtime/harness.mjs";

const CUSTOMER_ORIGIN = "http://localhost:8787";
const OPERATOR_ORIGIN = "http://ops.localhost:8787";
// Tuesday 2026-10-20 12:00 in Kuala Lumpur: bookings fit inside the 6-day
// window and weekday evening slots are comfortably ahead of the lead time.
const KL_NOW = new Date("2026-10-20T12:00:00+08:00");
const NOW_ISO = "2026-10-20T04:00:00.000Z";
const CTX = { waitUntil() {} };

const PHONE = "+60123456789";
const CUSTOMER_ID = `customer-${PHONE.replace(/\D/g, "")}`;
const IDEMPOTENCY_KEY = "integration-key-0000000001";

const BOOKING = {
  name: "Integration Capacity", phone: PHONE, block: "Block A/B", unit: "A-8-02",
  packageSize: 10, service: "standard", hangers: false,
  pickupDate: "2026-10-21", pickupSlot: "19:00", paymentMethod: "cash",
  termsAccepted: true,
};

let sandboxes = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(KL_NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  const closing = sandboxes;
  sandboxes = [];
  await Promise.all(closing.map((sandbox) => sandbox.close()));
});

function wrapDb(realDb) {
  const state = { beforeBatch: null };
  const db = new Proxy(realDb, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements, ...rest) => {
          const hook = state.beforeBatch;
          state.beforeBatch = null;
          if (hook) await hook();
          return target.batch(statements, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, state };
}

async function openSandbox() {
  const sandbox = await startHarness();
  sandboxes.push(sandbox);
  const realEnv = await sandbox.worker.getEnv();
  const { db, state } = wrapDb(realEnv.DB);
  const env = { ...realEnv, DB: db };
  return { sandbox, env, realDb: realEnv.DB, batchState: state };
}

// The local/test ratelimit bindings key on client IP; give each request a
// distinct loopback-unique IP so tests never share a limiter bucket. The
// dedicated rate-limit test pins one IP deliberately instead.
function randomTestIp() {
  return `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
}

function customerFetch(env, path, { method = "GET", body, key, ip = randomTestIp() } = {}) {
  const headers = { Origin: CUSTOMER_ORIGIN, "X-Forwarded-For": ip };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (key) headers["X-Idempotency-Key"] = key;
  return app.fetch(new Request(`${CUSTOMER_ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env, CTX);
}

function postBooking(env, body = BOOKING, key = IDEMPOTENCY_KEY) {
  return customerFetch(env, "/api/bookings", { method: "POST", body, key });
}

function operatorFetch(env, path, { method = "GET", body, email, ip = randomTestIp() } = {}) {
  const headers = {
    Origin: OPERATOR_ORIGIN,
    "X-Local-Operator-Email": email ?? env.LOCAL_OPERATOR_EMAIL,
    "X-Forwarded-For": ip,
  };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  return app.fetch(new Request(`${OPERATOR_ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env, CTX);
}

async function seedCustomer(realDb, { phone = PHONE, balance = 0 } = {}) {
  const id = `customer-${phone.replace(/\D/g, "")}`;
  await realDb.prepare(
    "INSERT OR IGNORE INTO customers (id, phone_e164, penalty_balance_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, phone, balance, NOW_ISO, NOW_ISO).run();
  return id;
}

async function seedPenalty(realDb, { id, customerId = CUSTOMER_ID, amount = 300 } = {}) {
  await realDb.prepare(
    `INSERT INTO penalty_events (id, customer_id, amount_cents, reason, state, created_at, updated_at)
     VALUES (?, ?, ?, 'late_cancellation', 'outstanding', ?, ?)`,
  ).bind(id, customerId, amount, NOW_ISO, NOW_ISO).run();
}

async function seedPromo(realDb, { id, code, kind = "fixed", value = 500, maxRedemptions = 1 } = {}) {
  await realDb.prepare(
    `INSERT INTO promotions (id, code, kind, value, min_service_cents, max_redemptions, redemptions, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, 1, ?, ?)`,
  ).bind(id, code, kind, value, maxRedemptions, NOW_ISO, NOW_ISO).run();
}

async function seedBooking(realDb, { id, number, phone = PHONE, date, slot, status = "confirmed" }) {
  const customerId = await seedCustomer(realDb, { phone });
  await realDb.prepare(
    `INSERT INTO bookings (
      id, booking_number, tracking_token_hash, customer_id, customer_name, phone, block, unit,
      package_size, service, folding, ironing, hangers, pickup_date, pickup_slot,
      service_total_cents, fee_total_cents, total_cents, payment_method, payment_status,
      status, ready_at, revision, terms_accepted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Seed', ?, 'Block A/B', 'A-8-02', 10, 'standard', 1, 1, 0, ?, ?,
      2999, 0, 2999, 'cash', 'unpaid', ?, ?, 1, 1, ?, ?)`,
  ).bind(id, number, `seed-hash-${id}`, customerId, phone, date, slot, status, NOW_ISO, NOW_ISO, NOW_ISO).run();
}

async function seedBlock(realDb, { id, date, slot = null, reason = "Seeded" }) {
  await realDb.prepare(
    "INSERT INTO blocked_slots (id, pickup_date, pickup_slot, reason, created_by, created_at) VALUES (?, ?, ?, ?, 'seed', ?)",
  ).bind(id, date, slot, reason, NOW_ISO).run();
}

const scalar = (realDb, sql, ...params) => realDb.prepare(sql).bind(...params).first();

describe("capacity D1 — guarded booking transaction", () => {
  it("A: creates a booking that clears the fee, consumes the promo, and writes exactly one event pair", async () => {
    const { env, realDb } = await openSandbox();
    await seedCustomer(realDb, { balance: 300 });
    await seedPenalty(realDb, { id: "pen-a" });
    await seedPromo(realDb, { id: "promo-a", code: "SAVE5" });

    const response = await postBooking(env, { ...BOOKING, promoCode: "SAVE5" });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.booking.number).toMatch(/^LL-[A-F0-9]{8}$/);
    expect(typeof created.trackingToken).toBe("string");

    const booking = await scalar(realDb, "SELECT * FROM bookings");
    expect(booking).toMatchObject({
      service_total_cents: 2999,
      fee_total_cents: 300,
      discount_cents: 500,
      total_cents: 2799,
      promo_code: "SAVE5",
      status: "confirmed",
    });
    expect((await scalar(realDb, "SELECT penalty_balance_cents FROM customers WHERE id = ?", CUSTOMER_ID)).penalty_balance_cents).toBe(0);
    expect((await scalar(realDb, "SELECT redemptions FROM promotions WHERE code = 'SAVE5'")).redemptions).toBe(1);
    const penalty = await scalar(realDb, "SELECT state, allocated_booking_id FROM penalty_events WHERE id = 'pen-a'");
    expect(penalty).toEqual({ state: "allocated", allocated_booking_id: booking.id });
    const events = await realDb.prepare("SELECT event_type, to_value FROM booking_events WHERE booking_id = ?").bind(booking.id).all();
    expect(events.results).toEqual([{ event_type: "status", to_value: "confirmed" }]);
    const audits = await realDb.prepare("SELECT event_type FROM booking_audit_events WHERE booking_id = ?").bind(booking.id).all();
    expect(audits.results).toEqual([{ event_type: "booking_created" }]);

    const replay = await postBooking(env, { ...BOOKING, promoCode: "SAVE5" });
    expect(replay.status).toBe(201);
    const replayed = await replay.json();
    expect(replayed.booking.number).toBe(created.booking.number);
    expect(replayed.trackingToken).toBe(created.trackingToken);
    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM bookings").first()).n).toBe(1);
    expect((await scalar(realDb, "SELECT redemptions FROM promotions WHERE code = 'SAVE5'")).redemptions).toBe(1);
    expect((await scalar(realDb, "SELECT penalty_balance_cents FROM customers WHERE id = ?", CUSTOMER_ID)).penalty_balance_cents).toBe(0);
    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM booking_events").first()).n).toBe(1);
    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM booking_audit_events").first()).n).toBe(1);
  });

  it("B: a whole-day block committed before the booking batch fails the guarded insert with slot_unavailable", async () => {
    const { env, realDb, batchState } = await openSandbox();
    await seedCustomer(realDb, { balance: 300 });
    await seedPenalty(realDb, { id: "pen-b" });
    await seedPromo(realDb, { id: "promo-b", code: "SAVE5" });

    let inner;
    batchState.beforeBatch = async () => {
      inner = await operatorFetch(env, "/api/operator/blocked-slots", {
        method: "POST",
        body: { pickupDate: "2026-10-21", pickupSlot: null, reason: "Raced whole-day" },
      });
    };
    const response = await postBooking(env, { ...BOOKING, promoCode: "SAVE5" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("slot_unavailable");
    expect(inner.status).toBe(201);

    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM bookings").first()).n).toBe(0);
    expect((await scalar(realDb, "SELECT penalty_balance_cents FROM customers WHERE id = ?", CUSTOMER_ID)).penalty_balance_cents).toBe(300);
    expect((await scalar(realDb, "SELECT redemptions FROM promotions WHERE code = 'SAVE5'")).redemptions).toBe(0);
    const penalty = await scalar(realDb, "SELECT state, allocated_booking_id FROM penalty_events WHERE id = 'pen-b'");
    expect(penalty).toEqual({ state: "outstanding", allocated_booking_id: null });
    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM booking_events").first()).n).toBe(0);
    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM booking_audit_events").first()).n).toBe(0);
  });

  it("C: a slot block committed before the reschedule batch fails the guarded update with slot_unavailable", async () => {
    const { env, realDb, batchState } = await openSandbox();
    const created = await postBooking(env);
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const bookingId = (await scalar(realDb, "SELECT id FROM bookings")).id;

    batchState.beforeBatch = async () => {
      await seedBlock(realDb, { id: "race-block", date: "2026-10-22", slot: "20:00" });
    };
    const response = await customerFetch(env, `/api/bookings/${createdBody.booking.number}/reschedule`, {
      method: "POST",
      body: {
        number: createdBody.booking.number,
        token: createdBody.trackingToken,
        phone: PHONE,
        pickupDate: "2026-10-22",
        pickupSlot: "20:00",
      },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("slot_unavailable");
    const row = await scalar(realDb, "SELECT pickup_date, pickup_slot, revision FROM bookings WHERE id = ?", bookingId);
    expect(row).toEqual({ pickup_date: "2026-10-21", pickup_slot: "19:00", revision: 1 });
  });
});

describe("capacity D1 — operator block lifecycle", () => {
  it("D: create, guarded remove with revision, stale replays, and recreate", async () => {
    const { env, realDb } = await openSandbox();

    const created = await operatorFetch(env, "/api/operator/blocked-slots", {
      method: "POST",
      body: { pickupDate: "2026-10-22", pickupSlot: "20:00", reason: "Staff leave" },
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const blockId = createdBody.block.id;
    expect(createdBody.block.revision).toBe(1);
    expect(createdBody.affectedBookings).toBe(0);
    let events = (await realDb.prepare("SELECT event_type, revision FROM capacity_events WHERE block_id = ? ORDER BY created_at").bind(blockId).all()).results;
    expect(events).toEqual([{ event_type: "created", revision: 1 }]);

    const missingBody = await operatorFetch(env, `/api/operator/blocked-slots/${blockId}`, { method: "DELETE" });
    expect(missingBody.status).toBe(400);
    const badRevision = await operatorFetch(env, `/api/operator/blocked-slots/${blockId}`, { method: "DELETE", body: { revision: 0 } });
    expect(badRevision.status).toBe(400);
    const wrongType = await operatorFetch(env, `/api/operator/blocked-slots/${blockId}`, { method: "DELETE", body: { revision: "1" } });
    expect(wrongType.status).toBe(400);
    const staleFirst = await operatorFetch(env, `/api/operator/blocked-slots/${blockId}`, { method: "DELETE", body: { revision: 2 } });
    expect(staleFirst.status).toBe(409);
    expect((await staleFirst.json()).code).toBe("stale_revision");

    const removed = await operatorFetch(env, `/api/operator/blocked-slots/${blockId}`, { method: "DELETE", body: { revision: 1 } });
    expect(removed.status).toBe(200);
    const row = await scalar(realDb, "SELECT revision, removed_at FROM blocked_slots WHERE id = ?", blockId);
    expect(row.revision).toBe(2);
    expect(row.removed_at).not.toBeNull();
    events = (await realDb.prepare("SELECT event_type, revision FROM capacity_events WHERE block_id = ? ORDER BY created_at").bind(blockId).all()).results;
    expect(events).toEqual([
      { event_type: "created", revision: 1 },
      { event_type: "removed", revision: 2 },
    ]);

    const repeat = await operatorFetch(env, `/api/operator/blocked-slots/${blockId}`, { method: "DELETE", body: { revision: 1 } });
    expect(repeat.status).toBe(409);
    expect((await repeat.json()).code).toBe("stale_revision");
    expect((await realDb.prepare("SELECT COUNT(*) AS n FROM capacity_events WHERE block_id = ?").bind(blockId).first()).n).toBe(2);

    const availability = await customerFetch(env, "/api/availability?date=2026-10-22");
    const availabilityBody = await availability.json();
    expect(availabilityBody.blockedSlots).not.toContain("20:00");
    expect(availabilityBody.blockedDate).toBe(false);
    const list = await operatorFetch(env, "/api/operator/blocked-slots");
    const listBody = await list.json();
    expect(listBody.blocks.map((block) => block.id)).not.toContain(blockId);

    const recreated = await operatorFetch(env, "/api/operator/blocked-slots", {
      method: "POST",
      body: { pickupDate: "2026-10-22", pickupSlot: "20:00", reason: "Staff leave" },
    });
    expect(recreated.status).toBe(201);
    const recreatedBody = await recreated.json();
    expect(recreatedBody.block.id).not.toBe(blockId);
    expect(recreatedBody.block.revision).toBe(1);
  });
});

describe("capacity D1 — list contract and input validation", () => {
  it("E: affectedBookings counts only matching active bookings and blocks expose no PII", async () => {
    const { env, realDb } = await openSandbox();
    await seedBooking(realDb, { id: "bk-1", number: "LL-AAAA0001", date: "2026-10-23", slot: "19:00" });
    await seedBooking(realDb, { id: "bk-2", number: "LL-AAAA0002", date: "2026-10-23", slot: "20:00" });
    await seedBooking(realDb, { id: "bk-3", number: "LL-AAAA0003", date: "2026-10-23", slot: "21:00", status: "delivered" });
    await seedBooking(realDb, { id: "bk-4", number: "LL-AAAA0004", date: "2026-10-23", slot: "10:00", status: "cancelled" });
    await seedBlock(realDb, { id: "blk-day", date: "2026-10-23", slot: null });
    await seedBlock(realDb, { id: "blk-slot", date: "2026-10-23", slot: "19:00" });
    await seedBlock(realDb, { id: "blk-empty", date: "2026-10-24", slot: null });

    const list = await operatorFetch(env, "/api/operator/blocked-slots");
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.page).toEqual({ limit: 100, offset: 0, hasMore: false });
    const byId = Object.fromEntries(body.blocks.map((block) => [block.id, block]));
    expect(byId["blk-day"].affectedBookings).toBe(2);
    expect(byId["blk-slot"].affectedBookings).toBe(1);
    expect(byId["blk-empty"].affectedBookings).toBe(0);
    const allowedKeys = new Set(["id", "pickupDate", "pickupSlot", "reason", "createdBy", "createdAt", "revision", "affectedBookings"]);
    for (const block of body.blocks) {
      for (const key of Object.keys(block)) expect(allowedKeys.has(key)).toBe(true);
    }

    const invalidShapes = [
      [1, 2, 3],
      "text",
      { pickupDate: 20261023, pickupSlot: "19:00" },
      { pickupDate: "2026-10-23", pickupSlot: 19 },
      { pickupDate: "2026-13-40" },
      { pickupDate: "2026-10-23", pickupSlot: "19:00", extra: true },
      { pickupDate: "2026-10-23", reason: "x".repeat(121) },
    ];
    for (const shape of invalidShapes) {
      const response = await operatorFetch(env, "/api/operator/blocked-slots", { method: "POST", body: shape });
      expect(response.status).toBe(400);
    }

    const first = await operatorFetch(env, "/api/operator/blocked-slots", {
      method: "POST",
      body: { pickupDate: "2026-10-24", pickupSlot: "10:00", reason: "Duplicate check" },
    });
    expect(first.status).toBe(201);
    const duplicate = await operatorFetch(env, "/api/operator/blocked-slots", {
      method: "POST",
      body: { pickupDate: "2026-10-24", pickupSlot: "10:00", reason: "Duplicate check" },
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe("already_blocked");

    const onCustomerHost = await app.fetch(new Request(`${CUSTOMER_ORIGIN}/api/operator/blocked-slots`, {
      headers: { Origin: CUSTOMER_ORIGIN, "X-Local-Operator-Email": env.LOCAL_OPERATOR_EMAIL },
    }), env, CTX);
    expect(onCustomerHost.status).toBe(404);

    const badEmail = await operatorFetch(env, "/api/operator/blocked-slots", { email: "intruder@example.invalid" });
    expect(badEmail.status).toBeGreaterThanOrEqual(400);
  });
});
