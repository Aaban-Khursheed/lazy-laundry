// Local rate-limiter evidence: the test config binds RATE_LIMITER (100/min)
// and RATE_LIMITER_BOOKING (5/min) like production, so a real 429 must be
// observable without production access. Handler runs in Node against the
// isolated harness env; the limiter binding itself is served by workerd.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../api/worker.js";
import { startHarness } from "../runtime/harness.mjs";

const CUSTOMER_ORIGIN = "http://localhost:8787";
const KL_NOW = new Date("2026-10-20T12:00:00+08:00");
const CTX = { waitUntil() {} };
const PINNED_IP = "10.77.7.7";

const BOOKING = {
  name: "Rate Limit Probe", phone: "+60199990000", block: "Block A/B", unit: "A-8-02",
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

describe("local rate limiter", () => {
  it("returns 429 after 5 booking POSTs per minute from one client IP", async () => {
    const sandbox = await startHarness();
    sandboxes.push(sandbox);
    const env = await sandbox.worker.getEnv();

    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await app.fetch(new Request(`${CUSTOMER_ORIGIN}/api/bookings`, {
        method: "POST",
        headers: {
          Origin: CUSTOMER_ORIGIN,
          "Content-Type": "application/json",
          "X-Forwarded-For": PINNED_IP,
          "X-Idempotency-Key": `rate-limit-probe-${i}-aaaaaaaaaaaaaaaa`,
        },
        body: JSON.stringify(BOOKING),
      }), env, CTX);
      statuses.push(response.status);
    }

    // Requests 1-5 consume the 5/min bucket (each may succeed or fail on
    // business rules); request 6 must be rejected by the limiter itself.
    expect(statuses[5]).toBe(429);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    const body = await app.fetch(new Request(`${CUSTOMER_ORIGIN}/api/bookings`, {
      method: "POST",
      headers: {
        Origin: CUSTOMER_ORIGIN,
        "Content-Type": "application/json",
        "X-Forwarded-For": PINNED_IP,
        "X-Idempotency-Key": "rate-limit-probe-6-aaaaaaaaaaaaaaaa",
      },
      body: JSON.stringify(BOOKING),
    }), env, CTX).then((r) => r.json());
    expect(body.error).toMatch(/too many requests/i);
  });

  it("does not share the bucket across distinct client IPs", async () => {
    const sandbox = await startHarness();
    sandboxes.push(sandbox);
    const env = await sandbox.worker.getEnv();

    for (let i = 0; i < 6; i += 1) {
      const response = await app.fetch(new Request(`${CUSTOMER_ORIGIN}/api/bookings`, {
        method: "POST",
        headers: {
          Origin: CUSTOMER_ORIGIN,
          "Content-Type": "application/json",
          "X-Forwarded-For": `10.88.8.${i}`,
          "X-Idempotency-Key": `rate-limit-distinct-${i}-aaaaaaaaaaaa`,
        },
        body: JSON.stringify(BOOKING),
      }), env, CTX);
      expect(response.status).not.toBe(429);
    }
  });
});
