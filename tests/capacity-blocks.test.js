import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { isScheduledSlot, scheduleFor } from "../api/worker.js";

const KEY = "capacity-retry-key-00000001";
const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ACTIVE_STATUSES = ["confirmed", "pickup_on_the_way", "laundry_picked_up", "processing", "ready"];

function fakeDB() {
  const byKey = new Map();
  const bookings = [];
  const blocked = [];
  const capacityEvents = [];
  const activeCountFor = (phone) => bookings.filter((r) => r.phone === phone && ACTIVE_STATUSES.includes(r.status)).length;
  const blockMatch = (date, slot) => blocked.find((r) => r.removed_at == null && r.pickup_date === date && (r.pickup_slot === null || r.pickup_slot === slot));
  const affectedFor = (blockRow) => bookings.filter((b) => b.pickup_date === blockRow.pickup_date
    && !["cancelled", "delivered"].includes(b.status)
    && (blockRow.pickup_slot === null || b.pickup_slot === blockRow.pickup_slot)).length;
  // Emulates D1's sequential batch semantics: changes() inside a statement
  // reflects the previous statement's write count, so the capacity_events
  // 'removed' insert is conditional on the soft-delete updating a row.
  const executeCapacity = (s, lastChanges) => {
    const { sql, params } = s;
    if (sql.includes("INSERT INTO blocked_slots")) {
      const dup = blocked.some((r) => r.removed_at == null && r.pickup_date === params[1]
        && (params[2] === null ? r.pickup_slot === null : r.pickup_slot === params[2]));
      if (dup) throw new Error("UNIQUE constraint failed: blocked_slots");
      blocked.push({
        id: params[0], pickup_date: params[1], pickup_slot: params[2], reason: params[3],
        created_by: params[4], created_at: params[5], revision: 1, removed_at: null, removed_by: null,
      });
      return { result: { meta: { changes: 1 } }, changes: 1 };
    }
    if (sql.includes("UPDATE blocked_slots SET removed_at")) {
      const row = blocked.find((r) => r.id === params[2]);
      const ok = Boolean(row) && row.removed_at == null && row.revision === params[3];
      if (ok) {
        row.removed_at = params[0];
        row.removed_by = params[1];
        row.revision += 1;
      }
      return { result: { meta: { changes: ok ? 1 : 0 } }, changes: ok ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO capacity_events")) {
      if (sql.includes("WHERE changes() = 1")) {
        if (lastChanges !== 1) return { result: { meta: { changes: 0 } }, changes: 0 };
        capacityEvents.push({ id: params[0], block_id: params[1], event_type: "removed", actor_id: params[2], reason: null, revision: params[3], created_at: params[4] });
        return { result: { meta: { changes: 1 } }, changes: 1 };
      }
      capacityEvents.push({ id: params[0], block_id: params[1], event_type: "created", actor_id: params[2], reason: params[3], revision: 1, created_at: params[4] });
      return { result: { meta: { changes: 1 } }, changes: 1 };
    }
    if (sql.includes("SELECT COUNT(*) AS n FROM bookings")) {
      const n = bookings.filter((b) => b.pickup_date === params[0]
        && !["cancelled", "delivered"].includes(b.status)
        && (params[1] === null || b.pickup_slot === params[1])).length;
      return { result: { results: [{ n }], meta: { changes: 0 } }, changes: 0 };
    }
    throw new Error(`Unexpected capacity statement: ${sql}`);
  };
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
      if (sql.includes("SELECT id, revision, removed_at FROM blocked_slots WHERE id = ?")) {
        return blocked.find((r) => r.id === params[0]) ?? null;
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
          const offset = params[2] || 0;
          const rows = blocked.filter((r) => r.removed_at == null && r.pickup_date >= params[0])
            .sort((a, b) => a.pickup_date.localeCompare(b.pickup_date)
              || (a.pickup_slot ?? "").localeCompare(b.pickup_slot ?? "")
              || a.id.localeCompare(b.id))
            .slice(offset, offset + params[1]);
          return { results: rows.map((r) => ({ ...r, affected_bookings: affectedFor(r) })) };
        }
        return { results: blocked.filter((r) => r.removed_at == null && r.pickup_date === params[0]) };
      }
      if (sql.includes("SELECT pickup_slot FROM bookings")) {
        return { results: bookings.filter((b) => b.pickup_date === params[0] && b.status !== "cancelled").map((b) => ({ pickup_slot: b.pickup_slot })) };
      }
      return { results: [] };
    },
    async run() {
      if (sql.includes("blocked_slots") || sql.includes("capacity_events")) {
        return executeCapacity({ sql, params }, 0).result;
      }
      throw new Error(`Unexpected run(): ${sql}`);
    },
  });
  const db = {
    hiddenBlockLookups: 0,
    blocked,
    bookings,
    capacityEvents,
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
      if (statements.some((s) => s.sql.includes("INSERT INTO blocked_slots") || s.sql.includes("UPDATE blocked_slots") || s.sql.includes("capacity_events"))) {
        const results = [];
        let lastChanges = 0;
        for (const s of statements) {
          const outcome = executeCapacity(s, lastChanges);
          results.push(outcome.result);
          lastChanges = outcome.changes;
        }
        return results;
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
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams", revision: 1, removed_at: null });
    const response = await postBooking(db, "2026-10-21", "19:00");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The pickup slot is no longer available", code: "slot_unavailable" });
  });

  it("rejects every slot on a whole-day blocked date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: null, reason: "Travel", revision: 1, removed_at: null });
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
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Raced", revision: 1, removed_at: null });
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
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams", revision: 1, removed_at: null });
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
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: null, reason: "Travel", revision: 1, removed_at: null });
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
      { id: "x1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams", revision: 1, removed_at: null },
      { id: "x2", pickup_date: "2026-10-22", pickup_slot: null, reason: "Travel", revision: 1, removed_at: null },
      { id: "x3", pickup_date: "2026-10-21", pickup_slot: "20:00", reason: "Removed", revision: 2, removed_at: "2026-10-20T03:00:00.000Z" },
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

  it("lists upcoming blocks with paging, schedule, and affected booking counts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push(
      { id: "old", pickup_date: "2026-10-19", pickup_slot: null, reason: "Past", revision: 1, removed_at: null },
      { id: "new", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams", created_by: "local.operator@example.invalid", created_at: "2026-10-20T04:00:00.000Z", revision: 1, removed_at: null },
      { id: "gone", pickup_date: "2026-10-22", pickup_slot: "20:00", reason: "Removed", revision: 3, removed_at: "2026-10-20T05:00:00.000Z" },
    );
    db.bookings.push(
      { id: "a1", pickup_date: "2026-10-21", pickup_slot: "19:00", status: "confirmed" },
      { id: "a2", pickup_date: "2026-10-21", pickup_slot: "20:00", status: "confirmed" },
      { id: "a3", pickup_date: "2026-10-21", pickup_slot: "19:00", status: "cancelled" },
    );
    const response = await operatorRequest("/api/operator/blocked-slots", "GET", null, db);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toEqual({ limit: 100, offset: 0, hasMore: false });
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toMatchObject({
      id: "new", pickupDate: "2026-10-21", pickupSlot: "19:00", reason: "Exams",
      createdBy: "local.operator@example.invalid", revision: 1, affectedBookings: 1,
    });
    for (const key of ["name", "customer_name", "phone", "trackingToken", "tracking_token_hash"]) {
      expect(body.blocks[0]).not.toHaveProperty(key);
    }
    expect(body.weekdaySlots).toEqual(["19:00", "20:00", "21:00"]);
    expect(body.weekendSlots).toContain("10:00");
  });

  it("pages the block list with limit and offset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const db = fakeDB();
    db.blocked.push(
      { id: "p1", pickup_date: "2026-10-21", pickup_slot: "19:00", revision: 1, removed_at: null },
      { id: "p2", pickup_date: "2026-10-21", pickup_slot: "20:00", revision: 1, removed_at: null },
      { id: "p3", pickup_date: "2026-10-22", pickup_slot: null, revision: 1, removed_at: null },
    );
    const first = await operatorRequest("/api/operator/blocked-slots?limit=2&offset=0", "GET", null, db);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.page).toEqual({ limit: 2, offset: 0, hasMore: true });
    expect(firstBody.blocks.map((b) => b.id)).toEqual(["p1", "p2"]);
    const second = await operatorRequest("/api/operator/blocked-slots?limit=2&offset=2", "GET", null, db);
    const secondBody = await second.json();
    expect(secondBody.page).toEqual({ limit: 2, offset: 2, hasMore: false });
    expect(secondBody.blocks.map((b) => b.id)).toEqual(["p3"]);
    const bad = await operatorRequest("/api/operator/blocked-slots?limit=0", "GET", null, db);
    expect(bad.status).toBe(400);
    const badOffset = await operatorRequest("/api/operator/blocked-slots?offset=-1", "GET", null, db);
    expect(badOffset.status).toBe(400);
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
    expect(body.block.revision).toBe(1);
    expect(body.affectedBookings).toBe(1);
    expect(db.blocked[0]).toMatchObject({ pickup_date: "2026-10-21", pickup_slot: "19:00", created_by: "local.operator@example.invalid", revision: 1, removed_at: null });
    expect(db.capacityEvents).toHaveLength(1);
    expect(db.capacityEvents[0]).toMatchObject({ block_id: body.block.id, event_type: "created", revision: 1 });
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
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Taken", revision: 1, removed_at: null });
    const dup = await operatorRequest("/api/operator/blocked-slots", "POST", { pickupDate: "2026-10-21", pickupSlot: "19:00" }, db);
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe("already_blocked");
  });

  it("removes a block only with the current revision and keeps the soft-deleted row", async () => {
    const db = fakeDB();
    db.blocked.push({ id: "00000000-0000-4000-8000-0000000000aa", pickup_date: "2026-10-21", pickup_slot: "19:00", reason: "Exams", revision: 1, removed_at: null });
    const path = "/api/operator/blocked-slots/00000000-0000-4000-8000-0000000000aa";

    const missing = await operatorRequest(path, "DELETE", null, db);
    expect(missing.status).toBe(400);
    const invalid = await operatorRequest(path, "DELETE", { revision: 0 }, db);
    expect(invalid.status).toBe(400);
    const wrongType = await operatorRequest(path, "DELETE", { revision: "1" }, db);
    expect(wrongType.status).toBe(400);
    const unknownField = await operatorRequest(path, "DELETE", { revision: 1, reason: "extra" }, db);
    expect(unknownField.status).toBe(400);

    const stale = await operatorRequest(path, "DELETE", { revision: 2 }, db);
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("stale_revision");

    const ok = await operatorRequest(path, "DELETE", { revision: 1 }, db);
    expect(ok.status).toBe(200);
    const row = db.blocked.find((r) => r.id === "00000000-0000-4000-8000-0000000000aa");
    expect(row).toBeTruthy();
    expect(row.removed_at).not.toBeNull();
    expect(row.revision).toBe(2);
    expect(db.capacityEvents.filter((e) => e.event_type === "removed")).toHaveLength(1);

    const repeat = await operatorRequest(path, "DELETE", { revision: 1 }, db);
    expect(repeat.status).toBe(409);
    expect(db.capacityEvents.filter((e) => e.event_type === "removed")).toHaveLength(1);

    const missingId = await operatorRequest("/api/operator/blocked-slots/00000000-0000-4000-8000-0000000000bb", "DELETE", { revision: 1 }, db);
    expect(missingId.status).toBe(404);
  });

  it("never serves or mutates blocks without valid operator auth", async () => {
    const db = fakeDB();
    db.blocked.push({ id: "b1", pickup_date: "2026-10-21", pickup_slot: null, reason: "Exams", revision: 1, removed_at: null });
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
