import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../api/worker.js";

const KEY = "audit-retry-key-0000000001";
const OTHER_KEY = "other-retry-key-0000000001";
const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const ACTIVE_STATUSES = ["confirmed", "pickup_on_the_way", "laundry_picked_up", "processing", "ready"];

function fakeDB() {
  const byKey = new Map();
  const byId = new Map();
  const activeCountFor = (phone) => [...byId.values()].filter((r) => r.phone === phone && ACTIVE_STATUSES.includes(r.status)).length;
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...next) => statement(sql, next),
    async first() {
      if (sql.includes("WHERE idempotency_key_hash = ?")) {
        if (db.hiddenLookups > 0) {
          db.hiddenLookups -= 1;
          return null;
        }
        return byKey.get(params[0]) ?? null;
      }
      if (sql.includes("COUNT(*) AS n FROM bookings")) {
        if (db.frozenCount !== null) {
          const n = db.frozenCount;
          db.frozenCount = null;
          return { n };
        }
        return { n: activeCountFor(params[0]) };
      }
      if (sql.includes("FROM customers WHERE id = ?")) return null;
      if (sql.includes("SELECT * FROM bookings WHERE id = ?")) return byId.get(params[0]) ?? null;
      throw new Error(`Unexpected first(): ${sql}`);
    },
    async all() {
      return { results: [] };
    },
  });
  const db = {
    hiddenLookups: 0,
    frozenCount: null,
    byId,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const insert = statements.find((s) => s.sql.includes("INSERT INTO bookings"));
      const p = insert.params;
      if ([...byId.values()].some((row) => row.pickup_date === p[14] && row.pickup_slot === p[15])) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: bookings.pickup_date, bookings.pickup_slot: SQLITE_CONSTRAINT");
      }
      if (byKey.has(p[4])) throw new Error("UNIQUE constraint failed: bookings.idempotency_key_hash");
      // The last two insert binds are the in-transaction cap (phone, limit).
      const capBlocked = activeCountFor(p[p.length - 2]) >= p[p.length - 1];
      if (!capBlocked) {
        const row = {
          id: p[0], booking_number: p[1], tracking_token_hash: p[2], encrypted_tracking_token: p[3],
          idempotency_key_hash: p[4], request_payload_hash: p[5], customer_id: p[6], customer_name: p[7],
          phone: p[8], block: p[9], unit: p[10], package_size: p[11], service: p[12], folding: 1, ironing: 1,
          hangers: p[13], pickup_date: p[14], pickup_slot: p[15], service_total_cents: p[16], fee_total_cents: p[17],
          total_cents: p[18], payment_method: p[19], promo_code: p[20], discount_cents: p[21], ready_at: p[22],
          payment_status: "unpaid", status: "confirmed", revision: 1, terms_accepted: 1, created_at: p[25], updated_at: p[26],
        };
        byKey.set(row.idempotency_key_hash, row);
        byId.set(row.id, row);
      }
      return statements.map((s) => ({ meta: { changes: s === insert && capBlocked ? 0 : 1 } }));
    },
  };
  return db;
}

function post(db, pickupDate, pickupSlot, key = KEY, overrides = {}) {
  return worker.fetch(new Request("http://localhost:8787/api/bookings", {
    method: "POST",
    headers: { Origin: "http://localhost:8787", "Content-Type": "application/json", "X-Idempotency-Key": key },
    body: JSON.stringify({
      name: "Audit Retry", phone: "+60123456789", block: "Block A/B", unit: "A-8-02", packageSize: 10,
      service: "standard", hangers: false, pickupDate, pickupSlot, paymentMethod: "cash", termsAccepted: true,
      ...overrides,
    }),
  }), { ENVIRONMENT: "local", CUSTOMER_HOSTS: "localhost", PUBLIC_BOOKING_ENABLED: "true", TRACKING_TOKEN_ENCRYPTION_KEY: encryptionKey, DB: db });
}

describe("booking idempotency", () => {
  afterEach(() => vi.useRealTimers());

  it("an identical retry seconds later replays the original booking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const first = await post(db, "2026-10-21", "19:00");
    const firstBody = await first.json();
    vi.setSystemTime(new Date("2026-10-20T12:00:02+08:00"));
    const retry = await post(db, "2026-10-21", "19:00");
    const retryBody = await retry.json();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retryBody.booking.number).toBe(firstBody.booking.number);
    expect(retryBody.trackingToken).toBe(firstBody.trackingToken);
  });

  it("an identical retry after the pickup start time still replays (fingerprint excludes server-derived fields)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T17:30:00+08:00"));
    const first = await post(db, "2026-10-20", "19:00");
    const firstBody = await first.json();
    vi.setSystemTime(new Date("2026-10-20T19:05:00+08:00"));
    const retry = await post(db, "2026-10-20", "19:00");
    const retryBody = await retry.json();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retryBody.booking.number).toBe(firstBody.booking.number);
    expect(retryBody.trackingToken).toBe(firstBody.trackingToken);
  });

  it("a booking inside the lead time is rejected with slot_unavailable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T18:30:00+08:00"));
    const response = await post(db, "2026-10-20", "19:00");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The pickup slot is no longer available", code: "slot_unavailable" });
  });

  it("an overlapping identical retry that loses the race receives the winner's booking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const first = await post(db, "2026-10-21", "19:00");
    const firstBody = await first.json();
    db.hiddenLookups = 1;
    const retry = await post(db, "2026-10-21", "19:00");
    const retryBody = await retry.json();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retryBody.booking.number).toBe(firstBody.booking.number);
    expect(retryBody.trackingToken).toBe(firstBody.trackingToken);
    expect(db.byId.size).toBe(1);
  });

  it("a different customer's key for a taken slot gets slot_taken", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const first = await post(db, "2026-10-21", "19:00");
    expect(first.status).toBe(201);

    const conflict = await post(db, "2026-10-21", "19:00", OTHER_KEY, { phone: "+60111111111" });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "That pickup slot has just been taken", code: "slot_taken" });
  });

  it("reusing a key with a different payload gets 422 idempotency_key_reused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const first = await post(db, "2026-10-21", "19:00");
    expect(first.status).toBe(201);

    const conflict = await post(db, "2026-10-21", "19:00", KEY, { name: "Someone Else" });

    expect(conflict.status).toBe(422);
    expect(await conflict.json()).toEqual({
      error: "This retry key was already used for a different booking",
      code: "idempotency_key_reused",
    });
  });
});

describe("per-phone active booking cap", () => {
  afterEach(() => vi.useRealTimers());

  const postAt = (db, slot, key, overrides = {}) => post(db, "2026-10-21", slot, key, overrides);

  it("rejects a third active booking for the same phone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    expect((await postAt(db, "19:00", KEY)).status).toBe(201);
    expect((await postAt(db, "20:00", OTHER_KEY)).status).toBe(201);

    const third = await postAt(db, "21:00", "third-retry-key-000000001");
    expect(third.status).toBe(409);
    expect(await third.json()).toEqual({
      error: "You already have 2 active bookings. Wait for one to be completed or cancel it before booking again.",
      code: "active_booking_limit",
    });
  });

  it("counts only active statuses — a cancelled booking frees capacity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    expect((await postAt(db, "19:00", KEY)).status).toBe(201);
    expect((await postAt(db, "20:00", OTHER_KEY)).status).toBe(201);
    for (const row of db.byId.values()) row.status = "cancelled";

    const third = await postAt(db, "21:00", "third-retry-key-000000001");
    expect(third.status).toBe(201);
  });

  it("does not affect other phone numbers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    expect((await postAt(db, "19:00", KEY)).status).toBe(201);
    expect((await postAt(db, "20:00", OTHER_KEY)).status).toBe(201);

    const other = await postAt(db, "21:00", "third-retry-key-000000001", { phone: "+60987654321" });
    expect(other.status).toBe(201);
  });

  it("the in-transaction guard catches a count that changes after the pre-check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    expect((await postAt(db, "19:00", KEY)).status).toBe(201);
    expect((await postAt(db, "20:00", OTHER_KEY)).status).toBe(201);
    // Simulate a raced pre-check: the count read is stale (0) while the
    // write-time count is already at the limit.
    db.frozenCount = 0;

    const raced = await postAt(db, "21:00", "third-retry-key-000000001");
    expect(raced.status).toBe(409);
    expect((await raced.json()).code).toBe("active_booking_limit");
    expect([...db.byId.values()].filter((r) => r.status === "confirmed")).toHaveLength(2);
  });
});

describe("turnaround commitments", () => {
  // Owner-confirmed overnight capability (README standing decisions): express
  // stays 6h even when it lands the ready time at ~03:00.

  it("a 21:00 express pickup promises a 6-hour overnight ready time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const response = await post(db, "2026-10-21", "21:00", KEY, { service: "express" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.booking.readyAt).toBe("2026-10-21T19:00:00.000Z");
  });

  it("a standard evening pickup promises 15 hours (next morning)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const response = await post(db, "2026-10-21", "19:00");
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.booking.readyAt).toBe("2026-10-22T02:00:00.000Z");
  });

  it("a standard weekend morning pickup promises 12 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDB();
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const response = await post(db, "2026-10-24", "10:00");
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.booking.readyAt).toBe("2026-10-24T14:00:00.000Z");
  });
});
