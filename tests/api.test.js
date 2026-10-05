import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let apiRequest;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("window", { location: { origin: "http://localhost:8787", hostname: "localhost" } });
  ({ apiRequest } = await import("../public/shared/api.js"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stalledFetch() {
  vi.stubGlobal("fetch", vi.fn((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  })));
}

describe("bounded same-origin API requests", () => {
  it("preserves structured error codes for quote recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Price changed", code: "quote_changed" }, { status: 409 })));
    await expect(apiRequest("/api/bookings", { method: "POST", body: {} })).rejects.toMatchObject({ status: 409, code: "quote_changed" });
  });

  it("times out lookups without falsely claiming a mutation occurred", async () => {
    vi.useFakeTimers();
    stalledFetch();
    const request = apiRequest("/api/track", { method: "POST", body: {}, timeoutMs: 100 });
    const result = expect(request).rejects.toMatchObject({ code: "request_timeout", outcomeUnknown: false });
    await vi.advanceTimersByTimeAsync(101);
    await result;
  });

  it("marks a timed-out mutation as having an unknown outcome", async () => {
    vi.useFakeTimers();
    stalledFetch();
    const request = apiRequest("/api/bookings", { method: "POST", body: {}, timeoutMs: 100 });
    const result = expect(request).rejects.toMatchObject({ code: "request_timeout", outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(101);
    await result;
  });

  it("preserves intentional cancellation instead of replacing it with an offline error", async () => {
    stalledFetch();
    const controller = new AbortController();
    const request = apiRequest("/api/operator/bookings", { signal: controller.signal });
    const result = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
  });

  it("bounds JSON body reading as well as the initial fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })));
    const result = expect(apiRequest("/api/config", { timeoutMs: 100 })).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(101);
    await result;
  });

  it("does not discard ambiguity after a server or malformed success response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad response", { status: 200 })));
    await expect(apiRequest("/api/bookings", { method: "POST", body: {} })).rejects.toMatchObject({ outcomeUnknown: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Failed to load saved order" }, { status: 503 })));
    await expect(apiRequest("/api/operator/bookings/id", { method: "PATCH", body: {} })).rejects.toMatchObject({ status: 503, outcomeUnknown: true });
  });
});
