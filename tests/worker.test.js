import { describe, expect, it } from "vitest";
import { formatSlot, getTodayString, isWeekend as clientIsWeekend, isSlotClosed as clientIsSlotClosed } from "../public/booking/modules/utils.js";
import worker, {
  canonicalize,
  csvCell,
  customerCancellationIsLate,
  isPickupSlotAvailable,
  isScheduledSlot,
  isValidDate,
  makeTrackingToken,
  priceInCents,
} from "../api/worker.js";

function localDateAfter(days) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  const next = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const nextValues = Object.fromEntries(next.map(({ type, value }) => [type, value]));
  return `${nextValues.year}-${nextValues.month}-${nextValues.day}`;
}

describe("booking domain helpers", () => {
  it("canonicalizes objects independently of insertion order", () => {
    expect(canonicalize({ z: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"z":1}');
  });

  it("uses the launch prices in integer sen", () => {
    expect(priceInCents(10, "standard", false)).toBe(2999);
    expect(priceInCents(10, "express", false)).toBe(3999);
    expect(priceInCents(18, "standard", true)).toBe(5499);
    expect(priceInCents(18, "express", true)).toBe(6999);
  });

  it("keeps client calendar rules anchored to Kuala Lumpur", () => {
    expect(clientIsWeekend("2026-10-04")).toBe(true);
    expect(clientIsWeekend("2026-10-05")).toBe(false);
    expect(clientIsSlotClosed(getTodayString(), "00:00")).toBe(true);
  });

  it("displays the actual Malaysia pickup time without historical timezone offsets", () => {
    expect(formatSlot("19:00")).toMatch(/^7:00\s?PM$/);
    expect(formatSlot("10:00")).toMatch(/^10:00\s?AM$/);
  });

  it("recognizes weekday and weekend schedules", () => {
    expect(isScheduledSlot("2026-10-05", "19:00")).toBe(true);
    expect(isScheduledSlot("2026-10-05", "10:00")).toBe(false);
    expect(isScheduledSlot("2026-10-04", "10:00")).toBe(true);
    expect(isScheduledSlot("2026-10-04", "18:00")).toBe(false);
  });

  it("rejects invalid calendar dates and accepts valid ISO dates", () => {
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-10-05")).toBe(true);
    expect(isValidDate("05-10-2026")).toBe(false);
  });

  it("allows a future scheduled slot within the seven-day window", () => {
    expect(isPickupSlotAvailable(localDateAfter(1), "19:00")).toBe(true);
    expect(isPickupSlotAvailable(localDateAfter(7), "19:00")).toBe(false);
  });

  it("marks cancellation late at and after the ten-minute cutoff", () => {
    expect(customerCancellationIsLate({ pickup_date: "2000-01-01", pickup_slot: "19:00" })).toBe(true);
    expect(customerCancellationIsLate({ pickup_date: "2999-01-01", pickup_slot: "19:00" })).toBe(false);
  });

  it("protects CSV exports from formula injection and quoting errors", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe("\"'=SUM(A1:A2)\"");
    expect(csvCell("Laundry, folded\nready")).toBe("\"Laundry, folded ready\"");
    expect(csvCell('Say "hi"')).toBe("\"Say \"\"hi\"\"\"");
  });

  it("generates private 256-bit URL-safe tracking tokens", () => {
    const first = makeTrackingToken();
    const second = makeTrackingToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });
});

describe("operator UI revision contract", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const env = {
    ENVIRONMENT: "local",
    OPERATOR_HOST: "ops.localhost",
    LOCAL_OPERATOR_EMAIL: "local.operator@example.invalid",
    OPERATOR_ALLOWED_EMAILS: "local.operator@example.invalid",
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id, revision: 3, status: "confirmed" }) }) }) },
  };
  const update = (input) => worker.fetch(new Request(`http://ops.localhost:8787/api/operator/bookings/${id}`, {
    method: "PATCH",
    headers: {
      Origin: "http://ops.localhost:8787",
      "Content-Type": "application/json",
      "X-Local-Operator-Email": "local.operator@example.invalid",
    },
    body: JSON.stringify(input),
  }), env);

  it("rejects a stale desktop revision before preparing any mutation", async () => {
    const response = await update({ action: "advance", revision: 2 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Booking changed; refresh and try again" });
  });

  it("requires a valid positive revision for every lifecycle or payment action", async () => {
    for (const revision of [undefined, 0, -1, "3", 3.5]) {
      const response = await update({ action: "paid", revision });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid update" });
    }
  });
});

describe("operator booking edit contract", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const futureDate = () => localDateAfter(2);
  const row = (overrides = {}) => ({
    id, booking_number: "LL-AB12CD34", customer_id: "cust-1", customer_name: "UI Test Customer",
    phone: "+60123456789", block: "Block A/B", unit: "A-8-02", package_size: 10, service: "standard",
    folding: 1, ironing: 1, hangers: 0, pickup_date: futureDate(), pickup_slot: "19:00",
    service_total_cents: 2999, fee_total_cents: 0, total_cents: 2999, payment_method: "cash",
    payment_status: "unpaid", status: "confirmed", revision: 3,
    ready_at: "2026-10-06T02:00:00.000Z", terms_accepted: 1, created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z", ...overrides,
  });
  const fakeDB = (current) => {
    const calls = [];
    return {
      calls,
      prepare: (sql) => {
        const statement = {
          bind: (...params) => { calls.push({ sql, params }); return statement; },
          first: async () => current,
          all: async () => ({ results: [] }),
        };
        return statement;
      },
      batch: async (statements) => statements.map(() => ({ meta: { changes: 1 } })),
    };
  };
  const update = (input, env) => worker.fetch(new Request(`http://ops.localhost:8787/api/operator/bookings/${id}`, {
    method: "PATCH",
    headers: {
      Origin: "http://ops.localhost:8787",
      "Content-Type": "application/json",
      "X-Local-Operator-Email": "local.operator@example.invalid",
    },
    body: JSON.stringify(input),
  }), {
    ENVIRONMENT: "local", OPERATOR_HOST: "ops.localhost",
    LOCAL_OPERATOR_EMAIL: "local.operator@example.invalid", OPERATOR_ALLOWED_EMAILS: "local.operator@example.invalid",
    DB: env,
  });

  it("edits fields, reprices, bumps revision, and audits the diff", async () => {
    const db = fakeDB(row());
    const response = await update({
      action: "edit", revision: 3, reason: "Customer called with a correction",
      fields: { name: "Updated Customer", packageSize: 18 },
    }, db);
    expect(response.status).toBe(200);
    const updateCall = db.calls.find((call) => call.sql.includes("UPDATE bookings"));
    expect(updateCall.sql).toContain("customer_name = ?");
    expect(updateCall.sql).toContain("package_size = ?");
    expect(updateCall.sql).toContain("service_total_cents = ?");
    expect(updateCall.sql).toContain("total_cents = ?");
    expect(updateCall.params).toContain("Updated Customer");
    expect(updateCall.params).toContain(18);
    expect(updateCall.params).toContain(5499);
    expect(updateCall.sql).toContain("revision = ?");
    expect(updateCall.params.at(-1)).toBe(3);
    const auditCall = db.calls.find((call) => call.sql.includes("booking_audit_events"));
    expect(auditCall.params.join("|")).toContain("operator_booking_edited");
  });

  it("blocks edits once payment is recorded or the order is past collection", async () => {
    for (const current of [row({ payment_status: "paid" }), row({ status: "processing" }), row({ status: "delivered" })]) {
      const response = await update({ action: "edit", revision: 3, reason: "fix", fields: { name: "New" } }, fakeDB(current));
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("This booking can no longer be edited");
    }
  });

  it("requires an audit reason and rejects invalid or unknown fields", async () => {
    const db = fakeDB(row());
    const noReason = await update({ action: "edit", revision: 3, fields: { name: "New" } }, db);
    expect(noReason.status).toBe(400);
    for (const fields of [
      { phone: "12345" },
      { name: "" },
      { block: "Block Z" },
      { unit: "Z-9-99" },
      { packageSize: 12 },
      { service: "deluxe" },
      { paymentMethod: "card" },
      { status: "confirmed" },
      { name: "New", unexpected: true },
    ]) {
      const response = await update({ action: "edit", revision: 3, reason: "fix", fields }, fakeDB(row()));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Invalid edit fields");
    }
  });

  it("rejects a no-change edit and a stale revision", async () => {
    const db = fakeDB(row());
    const noChange = await update({ action: "edit", revision: 3, reason: "fix", fields: { name: "UI Test Customer" } }, db);
    expect(noChange.status).toBe(400);
    expect((await noChange.json()).error).toBe("No changes to save");
    const stale = await update({ action: "edit", revision: 2, reason: "fix", fields: { name: "New" } }, fakeDB(row()));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("Booking changed; refresh and try again");
  });

  it("validates rescheduled slots without blocking unrelated edits to closed slots", async () => {
    const closedRow = row({ pickup_date: "2020-01-01", pickup_slot: "19:00" });
    const nameOnly = await update({ action: "edit", revision: 3, reason: "fix", fields: { name: "New Name" } }, fakeDB(closedRow));
    expect(nameOnly.status).toBe(200);
    const badSlot = await update({ action: "edit", revision: 3, reason: "fix", fields: { pickupDate: "2020-01-01" } }, fakeDB(row()));
    expect(badSlot.status).toBe(409);
    expect((await badSlot.json()).error).toBe("The pickup slot is no longer available");
    const db = fakeDB(row());
    const moved = await update({ action: "edit", revision: 3, reason: "Customer asked to move it", fields: { pickupSlot: "20:00" } }, db);
    expect(moved.status).toBe(200);
    const updateCall = db.calls.find((call) => call.sql.includes("UPDATE bookings"));
    expect(updateCall.sql).toContain("pickup_slot = ?");
    expect(updateCall.sql).toContain("ready_at = ?");
  });
});

describe("customer booking edit contract", () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const number = "LL-AB12CD34";
  const futureDate = () => localDateAfter(2);
  const token = "t".repeat(43);
  const row = (overrides = {}) => ({
    id, booking_number: number, customer_id: "cust-1", customer_name: "Customer Name",
    phone: "+60123456789", block: "Block A/B", unit: "A-8-02", package_size: 10, service: "standard",
    folding: 1, ironing: 1, hangers: 0, pickup_date: futureDate(), pickup_slot: "19:00",
    service_total_cents: 2999, fee_total_cents: 0, total_cents: 2999, payment_method: "cash",
    payment_status: "unpaid", status: "confirmed", revision: 3,
    ready_at: "2026-10-06T02:00:00.000Z", ...overrides,
  });
  const fakeDB = (current) => {
    const calls = [];
    return {
      calls,
      prepare: (sql) => {
        const statement = {
          bind: (...params) => { calls.push({ sql, params }); return statement; },
          first: async () => current,
          all: async () => ({ results: [] }),
        };
        return statement;
      },
      batch: async (statements) => statements.map(() => ({ meta: { changes: 1 } })),
    };
  };
  const edit = (body, db) => worker.fetch(new Request(`http://localhost:8787/api/bookings/${number}/edit`, {
    method: "POST",
    headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" },
    body: JSON.stringify({ number, token, phone: "+60123456789", ...body }),
  }), { ENVIRONMENT: "local", DB: db });

  it("loads the editable record without exposing the phone", async () => {
    const response = await edit({}, fakeDB(row()));
    expect(response.status).toBe(200);
    const { booking } = await response.json();
    expect(booking.name).toBe("Customer Name");
    expect(booking.block).toBe("Block A/B");
    expect(booking.packageSize).toBe(10);
    expect(booking.canEdit).toBe(true);
    expect(booking).not.toHaveProperty("phone");
  });

  it("edits fields, reprices, bumps revision and audits the diff", async () => {
    const db = fakeDB(row());
    const response = await edit({ fields: { name: "Updated Name", packageSize: 18 } }, db);
    expect(response.status).toBe(200);
    const updateCall = db.calls.find((call) => call.sql.includes("UPDATE bookings"));
    expect(updateCall.sql).toContain("customer_name = ?");
    expect(updateCall.sql).toContain("package_size = ?");
    expect(updateCall.sql).toContain("service_total_cents = ?");
    expect(updateCall.params).toContain("Updated Name");
    expect(updateCall.params).toContain(18);
    expect(updateCall.params).toContain(5499);
    expect(updateCall.sql).not.toContain("pickup_date = ?");
    expect(updateCall.sql).not.toContain("phone = ?");
    const auditCall = db.calls.find((call) => call.sql.includes("booking_audit_events"));
    expect(auditCall.sql).toContain("'customer_booking_edited'");
  });

  it("rejects fields the customer may not change", async () => {
    for (const fields of [
      { phone: "+60111111111" },
      { pickupDate: futureDate() },
      { pickupSlot: "20:00" },
      { status: "confirmed" },
      { name: "New", unexpected: true },
    ]) {
      const response = await edit({ fields }, fakeDB(row()));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Invalid edit fields");
    }
  });

  it("blocks edits when unpaid, late or past collection", async () => {
    for (const [current, message] of [
      [row({ payment_status: "paid" }), "This booking can no longer be edited"],
      [row({ status: "processing" }), "This booking can no longer be edited"],
      [row({ status: "cancelled" }), "This booking can no longer be edited"],
      [row({ pickup_date: "2020-01-01" }), "Editing is closed for this pickup"],
    ]) {
      const response = await edit({ fields: { name: "New" } }, fakeDB(current));
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(message);
    }
    const closed = await edit({}, fakeDB(row({ pickup_date: "2020-01-01" })));
    const { booking } = await closed.json();
    expect(booking.canEdit).toBe(false);
    expect(booking.editLate).toBe(true);
  });

  it("rejects a no-change edit and reports guarded-write conflicts", async () => {
    const noChange = await edit({ fields: { name: "Customer Name" } }, fakeDB(row()));
    expect(noChange.status).toBe(400);
    expect((await noChange.json()).error).toBe("No changes to save");
    const stalled = fakeDB(row());
    stalled.batch = async (statements) => statements.map(() => ({ meta: { changes: 0 } }));
    const response = await edit({ fields: { name: "New" } }, stalled);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("Booking changed; refresh and try again");
  });
});

describe("ambiguous booking recovery after the pickup window closes", () => {
  it.each(["true", "false"])("checks existing retry keys before expired-slot and intake-paused rejection (intake %s)", async (enabled) => {
    const response = await worker.fetch(new Request("http://localhost:8787/api/bookings", {
      method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json", "X-Idempotency-Key": "expired-recovery-key-00001" },
      body: JSON.stringify({ name: "Synthetic retry", phone: "+60123456789", block: "Block A/B", unit: "A-8-02", packageSize: 10,
        service: "standard", hangers: false, pickupDate: "2020-01-01", pickupSlot: "19:00", paymentMethod: "cash", termsAccepted: true }),
    }), {
      ENVIRONMENT: "local", CUSTOMER_HOSTS: "localhost", PUBLIC_BOOKING_ENABLED: enabled,
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ request_payload_hash: "different" }) }) }) },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This retry key was already used for a different booking" });
  });
});

describe("database-backed operator discovery", () => {
  const calls = [];
  const env = {
    ENVIRONMENT: "local", OPERATOR_HOST: "ops.localhost",
    LOCAL_OPERATOR_EMAIL: "local.operator@example.invalid", OPERATOR_ALLOWED_EMAILS: "local.operator@example.invalid",
    DB: { prepare: (sql) => {
      const statement = {
        bind: (...params) => { calls.push({ sql, params }); return statement; },
        all: async () => ({ results: [] }),
        first: async () => sql.includes("COUNT(*)") ? { total: 73 } : { pending: 30, active: 12, unpaid: 20, collected_cents: 2999 },
      };
      return statement;
    } },
  };
  const search = (body, host = "ops.localhost") => worker.fetch(new Request(`http://${host}:8787/api/operator/bookings/search`, {
    method: "POST", headers: { Origin: `http://${host}:8787`, "Content-Type": "application/json", "X-Local-Operator-Email": "local.operator@example.invalid" },
    body: JSON.stringify(body),
  }), env);

  it("searches literal customer queries safely in the body and returns paging metadata", async () => {
    calls.length = 0;
    const response = await search({ status: "active", query: "%' OR 1=1 --", date: "2026-10-04", limit: 25, offset: 25 });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.page).toEqual({ offset: 25, limit: 25, total: 73, hasMore: true });
    expect(payload.summary.collected).toBe(29.99);
    const query = calls.find((call) => call.sql.includes("LIMIT"));
    expect(query.sql).not.toContain("%' OR 1=1 --");
    expect(query.params).toContain("%' OR 1=1 --");
    expect(query.params.slice(-2)).toEqual([25, 25]);
    expect(query.sql).toContain("pickup_date = ?");
  });

  it("rejects unknown filters, unbounded search, invalid dates and pagination", async () => {
    for (const input of [{ status: "anything" }, { query: "x".repeat(201) }, { date: "2026-02-30" }, { limit: 1000 }, { offset: -1 }, { offset: "0" }, { secret: "unexpected" }]) {
      expect((await search(input)).status).toBe(400);
    }
  });

  it("does not expose operator search on the customer host", async () => {
    expect((await search({ query: "Customer" }, "localhost")).status).toBe(404);
  });
});

describe("modular frontend asset isolation", () => {
  const env = {
    ENVIRONMENT: "local",
    CUSTOMER_HOSTS: "localhost,127.0.0.1",
    OPERATOR_HOST: "ops.localhost",
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname) },
  };

  it("serves each application's stylesheet and the shared CVA bundle", async () => {
    for (const [host, path] of [
      ["localhost", "/booking/styles/layout.css"],
      ["ops.localhost", "/operator/modules/dashboard.js"],
      ["ops.localhost", "/operator/styles/workspace.css"],
      ["localhost", "/shared/variants.js"],
      ["ops.localhost", "/shared/variants.js"],
    ]) {
      const response = await worker.fetch(new Request(`http://${host}:8787${path}`), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(path);
    }
  });

  it("does not let either host load the other application's modules", async () => {
    for (const [host, path] of [
      ["localhost", "/operator/modules/dashboard.js"],
      ["localhost", "/operator/styles.css"],
      ["localhost", "/booking/modules/operator.js"],
      ["ops.localhost", "/booking/modules/booking.js"],
      ["ops.localhost", "/booking/modules/operator.js"],
      ["ops.localhost", "/booking/modules/api.js"],
    ]) {
      const response = await worker.fetch(new Request(`http://${host}:8787${path}`), env);
      expect(response.status).toBe(404);
    }
  });
});
