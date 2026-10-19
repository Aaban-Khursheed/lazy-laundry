import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../api/worker.js";

const KEY = "audit-retry-key-0000000001";
const OTHER_KEY = "other-retry-key-0000000001";
const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

function fakeDB() {
  const byKey = new Map();
  const byId = new Map();
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
    byId,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const p = statements.find((s) => s.sql.includes("INSERT INTO bookings")).params;
      if ([...byId.values()].some((row) => row.pickup_date === p[14] && row.pickup_slot === p[15])) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: bookings.pickup_date, bookings.pickup_slot: SQLITE_CONSTRAINT");
      }
      if (byKey.has(p[4])) throw new Error("UNIQUE constraint failed: bookings.idempotency_key_hash");
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
      return statements.map(() => ({ meta: { changes: 1 } }));
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
