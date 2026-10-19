import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../api/worker.js";

const KEY = "alert-retry-key-000000000001";
const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

function fakeCtx() {
  return { promises: [], waitUntil(promise) { this.promises.push(promise); } };
}

function fakeDB() {
  const byKey = new Map();
  const byId = new Map();
  const reminderRows = [];
  const retentionRows = [];
  const customers = [];
  const auditEvents = [];
  const notes = [];
  const penalties = [];
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...next) => statement(sql, next),
    async first() {
      if (sql.includes("WHERE idempotency_key_hash = ?")) return byKey.get(params[0]) ?? null;
      if (sql.includes("COUNT(*) AS n FROM bookings")) {
        const n = [...byId.values()].filter((r) => r.phone === params[0]
          && ["confirmed", "pickup_on_the_way", "laundry_picked_up", "processing", "ready"].includes(r.status)).length;
        return { n };
      }
      if (sql.includes("FROM customers WHERE id = ?")) return null;
      if (sql.includes("SELECT * FROM bookings WHERE id = ?")) return byId.get(params[0]) ?? null;
      throw new Error(`Unexpected first(): ${sql}`);
    },
    async all() {
      if (sql.includes("operator_reminded_at IS NULL")) {
        return {
          results: reminderRows.filter((row) => row.status === "confirmed" && !row.operator_reminded_at
            && row.created_at <= params[0]
            && Date.parse(`${row.pickup_date}T${row.pickup_slot}:00+08:00`) <= Date.parse(params[1])),
        };
      }
      if (sql.includes("SELECT id FROM customers c")) {
        return {
          results: customers.filter((c) => !c.anonymized_at && !c.id.startsWith("anon-")
            && c.penalty_balance_cents === 0
            && !retentionRows.some((b) => b.customer_id === c.id && !b.customer_anonymized_at)).slice(0, params[0]),
        };
      }
      if (sql.includes("SELECT id, customer_id FROM bookings")) {
        return {
          results: retentionRows.filter((row) => !row.customer_anonymized_at
            && (row.status === "delivered" || row.status === "cancelled")
            && row.updated_at <= params[0]
            && !customers.some((c) => c.id === row.customer_id && c.penalty_balance_cents > 0)).slice(0, params[1]),
        };
      }
      return { results: [] };
    },
  });
  const db = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const insert = statements.find((s) => s.sql.includes("INSERT INTO bookings"));
      if (insert) {
        const p = insert.params;
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
      }
      for (const s of statements) {
        if (s.sql.includes("UPDATE bookings SET operator_reminded_at")) {
          const row = reminderRows.find((r) => r.id === s.params[1]);
          if (row && !row.operator_reminded_at) row.operator_reminded_at = s.params[0];
        } else if (s.sql.includes("customer_name = ?")) {
          const row = retentionRows.find((r) => r.id === s.params[5]);
          if (row && !row.customer_anonymized_at) {
            Object.assign(row, { customer_name: s.params[0], phone: s.params[1], block: s.params[2], unit: s.params[3], customer_anonymized_at: s.params[4] });
          }
        } else if (s.sql.includes("details_json = NULL")) {
          for (const e of auditEvents) if (e.booking_id === s.params[0]) e.details_json = null;
        } else if (s.sql.includes("DELETE FROM operator_notes")) {
          for (let i = notes.length - 1; i >= 0; i--) if (notes[i].booking_id === s.params[0]) notes.splice(i, 1);
        } else if (s.sql.includes("INSERT INTO customers")) {
          const customer = customers.find((c) => c.id === s.params[2]);
          if (customer && !customer.anonymized_at) {
            customers.push({
              id: `anon-${customer.id}`, phone_e164: `anon-${customer.phone_e164.slice(-11)}`,
              penalty_balance_cents: customer.penalty_balance_cents, created_at: customer.created_at,
              updated_at: s.params[0], anonymized_at: s.params[1],
            });
          }
        } else if (s.sql.includes("UPDATE bookings SET customer_id")) {
          for (const row of retentionRows) if (row.customer_id === s.params[0]) row.customer_id = `anon-${row.customer_id}`;
        } else if (s.sql.includes("UPDATE penalty_events")) {
          for (const p of penalties) if (p.customer_id === s.params[0]) { p.customer_id = `anon-${p.customer_id}`; p.note = null; }
        } else if (s.sql.includes("UPDATE booking_audit_events SET customer_id")) {
          for (const e of auditEvents) if (e.customer_id === s.params[0]) e.customer_id = `anon-${e.customer_id}`;
        } else if (s.sql.includes("DELETE FROM customers")) {
          const i = customers.findIndex((c) => c.id === s.params[0]);
          if (i >= 0) customers.splice(i, 1);
        } else {
          throw new Error(`Unexpected batch(): ${s.sql}`);
        }
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { db, reminderRows, retentionRows, customers, auditEvents, notes, penalties, byId };
}

function bookingRequest(key = KEY) {
  return new Request("http://localhost:8787/api/bookings", {
    method: "POST",
    headers: { Origin: "http://localhost:8787", "Content-Type": "application/json", "X-Idempotency-Key": key },
    body: JSON.stringify({
      name: "Alert Test", phone: "+60123456789", block: "Block A/B", unit: "A-8-02", packageSize: 10,
      service: "standard", hangers: false, pickupDate: "2026-10-21", pickupSlot: "19:00",
      paymentMethod: "cash", termsAccepted: true,
    }),
  });
}

function envFor(db, email) {
  return {
    ENVIRONMENT: "local",
    CUSTOMER_HOSTS: "localhost",
    PUBLIC_BOOKING_ENABLED: "true",
    TRACKING_TOKEN_ENCRYPTION_KEY: encryptionKey,
    OPERATOR_ALERT_EMAIL: "ops-alerts@test.invalid",
    DB: db,
    ...(email ? { EMAIL: email } : {}),
  };
}

describe("operator alerts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emails the operator on a new booking without exposing the tracking token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const { db } = fakeDB();
    const email = { send: vi.fn(async () => ({ messageId: "m1" })) };
    const ctx = fakeCtx();
    const response = await worker.fetch(bookingRequest(), envFor(db, email), ctx);
    const body = await response.json();
    await Promise.all(ctx.promises);

    expect(response.status).toBe(201);
    expect(email.send).toHaveBeenCalledTimes(1);
    const message = email.send.mock.calls[0][0];
    expect(message.from.email).toBe("alerts@lazylaundry.me");
    expect(message.to).toBe("ops-alerts@test.invalid");
    expect(message.subject).toContain(body.booking.number);
    expect(message.subject).toContain("New booking");
    expect(message.text).toContain("wa.me/60123456789");
    expect(message.text).toContain("A-8-02");
    expect(message.text).toContain(`RM${body.booking.total.toFixed(2)}`);
    expect(message.text).not.toContain(body.trackingToken);
    expect(message.html).not.toContain(body.trackingToken);
  });

  it("an identical retry replays the booking without a second alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const { db } = fakeDB();
    const email = { send: vi.fn(async () => ({ messageId: "m1" })) };
    const ctx = fakeCtx();
    const first = await worker.fetch(bookingRequest(), envFor(db, email), ctx);
    const retry = await worker.fetch(bookingRequest(), envFor(db, email), ctx);
    await Promise.all(ctx.promises);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("a failed alert never fails the booking and permanent errors are not retried", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const { db } = fakeDB();
    const failure = Object.assign(new Error("domain not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    const email = { send: vi.fn(async () => { throw failure; }) };
    const ctx = fakeCtx();
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(bookingRequest(), envFor(db, email), ctx);
    await Promise.all(ctx.promises);

    expect(response.status).toBe(201);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("operator_alert_failed"));
  });

  it("retries a transient send failure once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const { db } = fakeDB();
    const failure = Object.assign(new Error("temporary"), { code: "E_INTERNAL_SERVER_ERROR" });
    const email = { send: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ messageId: "m2" }) };
    const ctx = fakeCtx();
    const response = await worker.fetch(bookingRequest(), envFor(db, email), ctx);
    await Promise.all(ctx.promises);

    expect(response.status).toBe(201);
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it("works when the EMAIL binding is absent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
    const { db } = fakeDB();
    const response = await worker.fetch(bookingRequest(), envFor(db, null), fakeCtx());
    expect(response.status).toBe(201);
  });
});

describe("pickup reminders", () => {
  const seed = (reminderRows, overrides = {}) => reminderRows.push({
    id: crypto.randomUUID(), booking_number: "LL-REMIND01", customer_name: "Reminder Test",
    phone: "+60123456789", block: "Block C", unit: "C-1-01", package_size: 10, service: "standard",
    hangers: 0, folding: 1, ironing: 1, pickup_date: "2026-10-20", pickup_slot: "19:00",
    total_cents: 1700, payment_method: "cash", payment_status: "unpaid", status: "confirmed",
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), operator_reminded_at: null,
    ...overrides,
  });

  it("emails a digest for unactioned bookings due soon and marks them once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, reminderRows } = fakeDB();
    seed(reminderRows);
    const email = { send: vi.fn(async () => ({ messageId: "m1" })) };
    const ctx = fakeCtx();
    await worker.scheduled({ cron: "*/15 * * * *" }, envFor(db, email), ctx);
    await Promise.all(ctx.promises);

    expect(email.send).toHaveBeenCalledTimes(1);
    const message = email.send.mock.calls[0][0];
    expect(message.subject).toContain("1 pickup due within 90 minutes");
    expect(message.text).toContain("LL-REMIND01");
    expect(reminderRows[0].operator_reminded_at).toBeTruthy();

    const ctx2 = fakeCtx();
    await worker.scheduled({ cron: "*/15 * * * *" }, envFor(db, email), ctx2);
    await Promise.all(ctx2.promises);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("skips very new bookings and bookings already actioned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, reminderRows } = fakeDB();
    seed(reminderRows, { created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    seed(reminderRows, { booking_number: "LL-ACTIVE01", status: "pickup_on_the_way" });
    const email = { send: vi.fn(async () => ({ messageId: "m1" })) };
    const ctx = fakeCtx();
    await worker.scheduled({ cron: "*/15 * * * *" }, envFor(db, email), ctx);
    await Promise.all(ctx.promises);

    expect(email.send).not.toHaveBeenCalled();
  });
});

describe("retention anonymization", () => {
  const OLD = "2024-05-01T00:00:00.000Z"; // ~29 months before the test clock — past the 24-month retention window
  const RECENT = "2026-09-01T00:00:00.000Z";

  const seedBooking = (retentionRows, overrides = {}) => retentionRows.push({
    id: crypto.randomUUID(), booking_number: "LL-OLD00001", customer_id: "customer-60123456789",
    customer_name: "Old Customer", phone: "+60123456789", block: "Block A", unit: "A-1-01",
    status: "delivered", updated_at: OLD, customer_anonymized_at: null, ...overrides,
  });

  const seedCustomer = (customers, overrides = {}) => customers.push({
    id: "customer-60123456789", phone_e164: "+60123456789",
    penalty_balance_cents: 0, created_at: OLD, updated_at: OLD, anonymized_at: null, ...overrides,
  });

  const runCron = async (db, email = { send: vi.fn(async () => ({ messageId: "m" })) }) => {
    const ctx = fakeCtx();
    await worker.scheduled({ cron: "*/15 * * * *" }, envFor(db, email), ctx);
    await Promise.all(ctx.promises);
    return email;
  };

  it("anonymizes terminal bookings older than 12 months and frees the customer identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, retentionRows, customers, auditEvents, notes, penalties } = fakeDB();
    seedBooking(retentionRows);
    seedCustomer(customers);
    auditEvents.push({ booking_id: retentionRows[0].id, customer_id: "customer-60123456789", details_json: '{"changes":{"phone":{"from":"+60123456789","to":"+60999"}}}' });
    notes.push({ booking_id: retentionRows[0].id, note: "customer called twice" });
    penalties.push({ customer_id: "customer-60123456789", note: "waived after chat" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCron(db);

    const booking = retentionRows[0];
    expect(booking.customer_name).toBe("Former customer");
    expect(booking.phone).toBe("removed");
    expect(booking.block).toBe("removed");
    expect(booking.unit).toBe("removed");
    expect(booking.customer_anonymized_at).toBeTruthy();
    expect(booking.customer_id).toBe("anon-customer-60123456789");
    expect(notes).toHaveLength(0);
    expect(auditEvents[0].details_json).toBeNull();
    expect(auditEvents[0].customer_id).toBe("anon-customer-60123456789");
    expect(penalties[0].customer_id).toBe("anon-customer-60123456789");
    expect(penalties[0].note).toBeNull();

    // The natural id and phone are free again, so a returning customer can re-book.
    expect(customers.find((c) => c.id === "customer-60123456789")).toBeUndefined();
    const anon = customers.find((c) => c.id === "anon-customer-60123456789");
    expect(anon).toBeTruthy();
    expect(anon.phone_e164).toBe("anon-60123456789");
    expect(anon.penalty_balance_cents).toBe(0);

    // Logs carry counts only — never PII.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("retention_anonymized");
    expect(logged).not.toContain("60123456789");
    expect(logged).not.toContain("Old Customer");
  });

  it("leaves recent or active bookings and their customer identifiable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, retentionRows, customers } = fakeDB();
    seedBooking(retentionRows, { updated_at: RECENT });
    seedBooking(retentionRows, { id: crypto.randomUUID(), status: "confirmed", updated_at: OLD });
    seedCustomer(customers);
    await runCron(db);

    expect(retentionRows[0].customer_anonymized_at).toBeNull();
    expect(retentionRows[1].customer_anonymized_at).toBeNull();
    expect(customers.find((c) => c.id === "customer-60123456789")).toBeTruthy();
  });

  it("keeps the customer row while any booking stays identifiable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, retentionRows, customers } = fakeDB();
    seedBooking(retentionRows);
    seedBooking(retentionRows, { id: crypto.randomUUID(), updated_at: RECENT });
    seedCustomer(customers);
    await runCron(db);

    expect(retentionRows[0].customer_anonymized_at).toBeTruthy();
    expect(retentionRows[1].customer_anonymized_at).toBeNull();
    expect(customers.find((c) => c.id === "customer-60123456789")).toBeTruthy();
    expect(customers.find((c) => c.id === "anon-customer-60123456789")).toBeUndefined();
  });

  it("keeps records needed for an outstanding penalty until it is resolved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, retentionRows, customers } = fakeDB();
    seedBooking(retentionRows);
    seedCustomer(customers, { penalty_balance_cents: 300 });
    await runCron(db);

    expect(retentionRows[0].customer_anonymized_at).toBeNull();
    expect(retentionRows[0].phone).toBe("+60123456789");
    expect(customers.find((c) => c.id === "customer-60123456789")).toBeTruthy();
    expect(customers.find((c) => c.id.startsWith("anon-"))).toBeUndefined();
  });

  it("does not reprocess an already anonymized customer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T18:00:00+08:00"));
    const { db, retentionRows, customers } = fakeDB();
    seedBooking(retentionRows, { customer_name: "Former customer", phone: "removed", block: "removed", unit: "removed", customer_anonymized_at: OLD });
    seedCustomer(customers);
    await runCron(db);

    // Customer anonymizes (all bookings scrubbed); second run is a no-op.
    expect(customers.find((c) => c.id === "customer-60123456789")).toBeUndefined();
    const anonId = customers[0].id;
    await runCron(db);
    expect(customers.filter((c) => c.id === anonId)).toHaveLength(1);
    expect(customers).toHaveLength(1);
  });
});
