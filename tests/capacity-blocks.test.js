import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { isScheduledSlot, scheduleFor } from "../api/worker.js";

const KEY = "capacity-retry-key-00000001";
const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ACTIVE_STATUSES = ["confirmed", "pickup_on_the_way", "laundry_picked_up", "processing", "ready"];

function fakeDB() {
  const byKey = new Map();
  const bookings = [];
  const blocked = [];
  const activeCountFor = (phone) => bookings.filter((r) => r.phone === phone && ACTIVE_STATUSES.includes(r.status)).length;
  const blockMatch = (date, slot) => blocked.find((r) => r.pickup_date === date && (r.pickup_slot === null || r.pickup_slot === slot));
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...next) => statement(sql, next),
    async first() {
      if (sql.includes("WHERE idempotency_key_hash = ?")) return byKey.get(params[0]) ?? null;
      if (sql.includes("COUNT(*) AS n FROM bookings WHERE phone")) return { n: activeCountFor(params[0]) };
      if (sql.includes("COUNT(*) AS n FROM bookings")) {
        return { n: bookings.filter((b) => b.pickup_date === params[0] && !["cancelled", "delivered"].includes(b.status)
          && (params[1] === null || b.pickup_slot === params[1])).length };
      }
      if (sql.includes("FROM blocked_slots WHERE pickup_date = ? AND (pickup_slot IS NULL OR pickup_slot = ?)")) {
        if (db.hiddenBlockLookups > 0) {
          db.hiddenBlockLookups -= 1;
          return null;
        }
        return blockMatch(params[0], params[1]) ?? null;
      }
      if (sql.includes("FROM blocked_slots WHERE id = ?")) return blocked.find((r) => r.id === params[0]) ?? null;
      if (sql.includes("FROM customers WHERE id = ?")) return null;
      if (sql.includes("FROM bookings b LEFT JOIN")) return bookings.find((b) => b.booking_number === params[0]) ?? null;
      if (sql.includes("SELECT * FROM bookings WHERE id = ?")) return bookings.find((b) => b.id === params[0]) ?? null;
      throw new Error(`Unexpected first(): ${sql}`);
    },
    async all() {
      if (sql.includes("FROM blocked_slots")) {
        if (sql.includes("pickup_date >= ?")) {
          return { results: blocked.filter((r) => r.pickup_date >= params[0]).sort((a, b) => `${a.pickup_date}${a.pickup_slot}`.localeCompare(`${b.pickup_date}${b.pickup_slot}`)) };
        }
        return { results: blocked.filter((r) => r.pickup_date === params[0]) };
      }
      if (sql.includes("SELECT pickup_slot FROM bookings")) {
        return { results: bookings.filter((b) => b.pickup_date === params[0] && b.status !== "cancelled").map((b) => ({ pickup_slot: b.pickup_slot })) };
      }
      return { results: [] };
    },
    async run() {
      if (sql.includes("INSERT INTO blocked_slots")) {
        const dup = blocked.some((r) => r.pickup_date === params[1] && r.pickup_slot === params[2]);
        if (dup) throw new Error("UNIQUE constraint failed: blocked_slots");
        blocked.push({ id: params[0], pickup_date: params[1], pickup_slot: params[2], reason: params[3], created_by: params[4], created_at: params[5] });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("DELETE FROM blocked_slots")) {
        const index = blocked.findIndex((r) => r.id === params[0]);
        if (index < 0) return { meta: { changes: 0 } };
        blocked.splice(index, 1);
        return { meta: { changes: 1 } };
      }
      throw new Error(`Unexpected run(): ${sql}`);
    },
  });
  const db = {
    hiddenBlockLookups: 0,
    blocked,
    bookings,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const insert = statements.find((s) => s.sql.includes("INSERT INTO bookings"));
      if (insert) {
        const p = insert.params;
        if (bookings.some((row) => row.pickup_date === p[14] && row.pickup_slot === p[15])) {
          throw new Error("D1_ERROR: UNIQUE constraint failed: bookings.pickup_date, bookings.pickup_slot: SQLITE_CONSTRAINT");
        }
        if (byKey.has(p[4])) throw new Error("UNIQUE constraint failed: bookings.idempotency_key_hash");
        const capBlocked = activeCountFor(p[p.length - 4]) >= p[p.length - 3];
        const slotBlocked = Boolean(blockMatch(p[p.length - 2], p[p.length - 1]));
        if (!capBlocked && !slotBlocked) {
          const row = {
            id: p[0], booking_number: p[1], tracking_token_hash: p[2], encrypted_tracking_token: p[3],
            idempotency_key_hash: p[4], request_payload_hash: p[5], customer_id: p[6], customer_name: p[7],
            phone: p[8], block: p[9], unit: p[10], package_size: p[11], service: p[12], folding: 1, ironing: 1,
            hangers: p[13], pickup_date: p[14], pickup_slot: p[15], service_total_cents: p[16], fee_total_cents: p[17],
            total_cents: p[18], payment_method: p[19], promo_code: p[20], discount_cents: p[21], ready_at: p[22],
            payment_status: "unpaid", status: "confirmed", revision: 1, terms_accepted: 1, created_at: p[25], updated_at: p[26],
          };
          byKey.set(row.idempotency_key_hash, row);
          bookings.push(row);
        }
        return statements.map((s) => ({ meta: { changes: s === insert && (capBlocked || slotBlocked) ? 0 : 1 } }));
      }
      const update = statements.find((s) => s.sql.includes("UPDATE bookings SET pickup_date"));
      if (update) {
        const p = update.params;
        const row = bookings.find((b) => b.id === p[4]);
        const guardOk = row && row.revision === p[5] && ACTIVE_STATUSES.includes(row.status) && !blockMatch(p[0], p[1]);
        if (guardOk) {
          row.pickup_date = p[0];
          row.pickup_slot = p[1];
          row.revision += 1;
        }
        return statements.map((s) => ({ meta: { changes: s === update && !guardOk ? 0 : 1 } }));
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return db;
}

function postBooking(db, pickupDate, pickupSlot, key = KEY) {
  return worker.fetch(new Request("http://localhost:8787/api/bookings", {
    method: "POST",
    headers: { Origin: "http://localhost:8787", "Content-Type": "application/json", "X-Idempotency-Key": key },
    body: JSON.stringify({
      name: "Capacity Test", phone: "+60123456789", block: "Block A/B", unit: "A-8-02", packageSize: 10,
      service: "standard", hangers: false, pickupDate, pickupSlot, paymentMethod: "cash", termsAccepted: true,
    }),
  }), { ENVIRONMENT: "local", CUSTOMER_HOSTS: "localhost", PUBLIC_BOOKING_ENABLED: "true", TRACKING_TOKEN_ENCRYPTION_KEY: encryptionKey, DB: db });
}

const OPERATOR_ENV = (db) => ({
  ENVIRONMENT: "local",
  OPERATOR_HOST: "ops.localhost",
  LOCAL_OPERATOR_EMAIL: "local.operator@example.invalid",
  OPERATOR_ALLOWED_EMAILS: "local.operator@example.invalid",
  DB: db,
});

function operatorRequest(path, method, body, db, email = "local.operator@example.invalid") {
  const headers = { Origin: "http://ops.localhost:8787", "Content-Type": "application/json" };
  if (email) headers["X-Local-Operator-Email"] = email;
  return worker.fetch(new Request(`http://ops.localhost:8787${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), OPERATOR_ENV(db));
}

describe("capacity blocks — customer booking", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a booking on a blocked slot with slot_unavailable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams" });
    const response = await postBooking(db, "2026-10-21", "19:00");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The pickup slot is no longer available", code: "slot_unavailable" });
  });

  it("rejects every slot on a whole-day blocked date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: null, reason: "Travel" });
    for (const slot of ["19:00", "20:00", "21:00"]) {
      const response = await postBooking(db, "2026-10-21", slot, `whole-day-key-${slot.replace(":", "")}00`);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("slot_unavailable");
    }
  });

  it("the in-transaction guard catches a block set after the availability pre-check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Raced" });
    db.hiddenBlockLookups = 1;
    const response = await postBooking(db, "2026-10-21", "19:00");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("slot_unavailable");
    expect(db.bookings).toHaveLength(0);
  });

  it("accepts a booking once the block is removed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    const response = await postBooking(db, "2026-10-21", "19:00");
    expect(response.status).toBe(201);
  });
});

describe("capacity blocks — customer reschedule", () => {
  afterEach(() => vi.useRealTimers());

  const existing = (overrides = {}) => ({
    id: "b-existing", booking_number: "LL-AB12CD34", tracking_token_hash: "hash",
    customer_id: "customer-60123456789", customer_name: "Capacity Test", phone: "+60123456789",
    block: "Block A/B", unit: "A-8-02", package_size: 10, service: "standard",
    pickup_date: "2026-10-22", pickup_slot: "20:00", status: "confirmed", revision: 3,
    payment_status: "unpaid", ...overrides,
  });

  function reschedule(db, pickupDate, pickupSlot) {
    return worker.fetch(new Request("http://localhost:8787/api/bookings/LL-AB12CD34/reschedule", {
      method: "POST",
      headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" },
      body: JSON.stringify({ number: "LL-AB12CD34", token: "t".repeat(43), phone: "+60123456789", pickupDate, pickupSlot }),
    }), { ENVIRONMENT: "local", CUSTOMER_HOSTS: "localhost", DB: db });
  }

  it("rejects a reschedule onto a blocked slot before writing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.bookings.push(existing());
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams" });
    const response = await reschedule(db, "2026-10-21", "19:00");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("slot_unavailable");
    expect(db.bookings[0].pickup_date).toBe("2026-10-22");
  });

  it("the guarded update rejects a block set after the pre-check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.bookings.push(existing());
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: null, reason: "Travel" });
    db.hiddenBlockLookups = 1;
    const response = await reschedule(db, "2026-10-21", "19:00");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("slot_unavailable");
    expect(db.bookings[0].pickup_date).toBe("2026-10-22");
  });
});

describe("capacity blocks — public availability", () => {
  it("returns blocked slots and a whole-date flag alongside booked slots", async () => {
    const db = fakeDB();
    db.bookings.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "20:00", status: "confirmed" });
    db.blocked.push(
      { id: "x1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams" },
      { id: "x2", pickup_date: "2026-10-22", pickup_slot: null, reason: "Travel" },
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const response = await worker.fetch(new Request("http://localhost:8787/api/availability?date=2026-10-21", {
      headers: { Origin: "http://localhost:8787" },
    }), { ENVIRONMENT: "local", CUSTOMER_HOSTS: "localhost", DB: db });
    vi.useRealTimers();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.bookedSlots).toEqual(["20:00"]);
    expect(body.blockedSlots).toEqual(["19:00"]);
    expect(body.blockedDate).toBe(false);
    const dayBlocked = await worker.fetch(new Request("http://localhost:8787/api/availability?date=2026-10-22", {
      headers: { Origin: "http://localhost:8787" },
    }), { ENVIRONMENT: "local", CUSTOMER_HOSTS: "localhost", DB: db });
    expect((await dayBlocked.json()).blockedDate).toBe(true);
  });
});

describe("operator capacity endpoints", () => {
  afterEach(() => vi.useRealTimers());

  it("lists upcoming blocks with the active pickup schedule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push(
      { id: "old", pickup_date: "2026-10-19", pickup_slot: null, reason: "Past" },
      { id: "new", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams", created_at: "2026-10-20T04:00:00.000Z" },
    );
    const response = await operatorRequest("/api/operator/blocked-slots", "GET", null, db);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toMatchObject({ id: "new", pickupDate: "2026-10-21", pickupSlot: "19:00", reason: "Exams" });
    expect(body.weekdaySlots).toEqual(["19:00", "20:00", "21:00"]);
    expect(body.weekendSlots).toContain("10:00");
  });

  it("creates a slot block and reports affected active bookings", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.bookings.push(
      { id: "a1", pickup_date: "2026-10-21", pickup_slot: "19:00", status: "confirmed" },
      { id: "a2", pickup_date: "2026-10-21", pickup_slot: "20:00", status: "confirmed" },
      { id: "a3", pickup_date: "2026-10-21", pickup_slot: "19:00", status: "cancelled" },
    );
    const response = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-21", pickupSlot: "19:00", reason: "Exams" }, db);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.block.pickupSlot).toBe("19:00");
    expect(body.affectedBookings).toBe(1);
    expect(db.blocked[0]).toMatchObject({ pickup_date: "2026-10-21", pickup_slot: "19:00", created_by: "local.operator@example.invalid" });
  });

  it("creates a whole-day block when pickupSlot is null", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    const response = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-21", pickupSlot: null, reason: "Travel" }, db);
    expect(response.status).toBe(201);
    expect(db.blocked[0].pickup_slot).toBeNull();
  });

  it("rejects past dates, non-scheduled slots, and duplicates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    const past = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-19", pickupSlot: null }, db);
    expect(past.status).toBe(400);
    const invalid = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-21", pickupSlot: "10:00" }, db);
    expect(invalid.status).toBe(400);
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Taken" });
    const dup = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-21", pickupSlot: "19:00" }, db);
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe("already_blocked");
  });

  it("removes a block and reports unknown ids", async () => {
    const db = fakeDB();
    db.blocked.push({ id: "00000000-0000-4000-8000-0000000000aa", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams" });
    const ok = await operatorRequest("/api/operator/blocked-slots/00000000-0000-4000-8000-0000000000aa", "DELETE", null, db);
    expect(ok.status).toBe(200);
    expect(db.blocked).toHaveLength(0);
    const missing = await operatorRequest("/api/operator/blocked-slots/00000000-0000-4000-8000-0000000000bb", "DELETE", null, db);
    expect(missing.status).toBe(404);
  });

  it("never serves or mutates blocks without valid operator auth", async () => {
    const db = fakeDB();
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: null, reason: "Exams" });
    // Without Access configured, an unknown local header does not take the
    // local-identity shortcut — it falls through to JWT verification and fails
    // closed (401/403/503 depending on which check rejects first).
    const response = await operatorRequest("/api/operator/blocked-slots", "GET", null, db, "intruder@example.invalid");
    expect(response.status).toBeGreaterThanOrEqual(400);
    const created = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-22", pickupSlot: null }, db, "intruder@example.invalid");
    expect(created.status).toBeGreaterThanOrEqual(400);
    expect(db.blocked).toHaveLength(1);
  });
});

describe("pickup schedule configuration", () => {
  it("parses PICKUP_SLOTS_WEEKDAY/WEEKEND and falls back on invalid values", () => {
    expect(scheduleFor({ PICKUP_SLOTS_WEEKDAY: "18:00,19:00", PICKUP_SLOTS_WEEKEND: "09:00" })).toEqual({
      weekday: ["18:00", "19:00"],
      weekend: ["09:00"],
    });
    expect(scheduleFor({ PICKUP_SLOTS_WEEKDAY: "nonsense", PICKUP_SLOTS_WEEKEND: "" })).toEqual({
      weekday: ["19:00", "20:00", "21:00"],
      weekend: ["10:00", "11:00", "12:00", "19:00", "20:00", "21:00"],
    });
    expect(isScheduledSlot("2026-10-21", "18:00", scheduleFor({ PICKUP_SLOTS_WEEKDAY: "18:00" }))).toBe(true);
    expect(isScheduledSlot("2026-10-21", "19:00", scheduleFor({ PICKUP_SLOTS_WEEKDAY: "18:00" }))).toBe(false);
  });
});
