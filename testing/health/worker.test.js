import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { afterEach, describe, expect, it } from "vitest";
import { blockedAttempts, blockOutbound } from "../runtime/outbound.mjs";
import { startHarness } from "../runtime/harness.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrationNames = readdirSync(new URL("../../api/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();

let sandboxes = [];

afterEach(async () => {
  const closing = sandboxes;
  sandboxes = [];
  await Promise.all(closing.map((sandbox) => sandbox.close()));
});

async function openHarness() {
  const sandbox = await startHarness();
  sandboxes.push(sandbox);
  return sandbox;
}

describe("isolated Worker and D1 health baseline", () => {
  it("serves health after applying the complete migration set without real service bindings", async () => {
    const sandbox = await openHarness();
    const response = await sandbox.server.fetch(new URL("/api/health", sandbox.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    const env = await sandbox.worker.getEnv();
    const migrations = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
    expect(migrations.results.map((row) => row.name)).toEqual(migrationNames);
    expect(env.EMAIL).toBeUndefined();
    // Rate-limit bindings are deliberately present (in-memory local limiters
    // matching production config). Never assert them with toBeUndefined-style
    // serialization — inspecting an RpcStub throws.
    expect(env.RATE_LIMITER).toBeTruthy();
    expect(env.RATE_LIMITER_BOOKING).toBeTruthy();
    expect(env.ACCESS_TEAM_DOMAIN).toBeUndefined();
    expect(env.ACCESS_AUD).toBeUndefined();
    expect(env.TURNSTILE_SECRET).toBeUndefined();
  });

  it("keeps concurrent harness databases independent", async () => {
    const [a, b] = await Promise.all([openHarness(), openHarness()]);
    const envA = await a.worker.getEnv();
    const envB = await b.worker.getEnv();
    await Promise.all([
      envA.DB.prepare("CREATE TABLE __infra_probe (id TEXT PRIMARY KEY NOT NULL)").run(),
      envB.DB.prepare("CREATE TABLE __infra_probe (id TEXT PRIMARY KEY NOT NULL)").run(),
    ]);

    await envA.DB.prepare("INSERT INTO __infra_probe (id) VALUES (?)").bind("marker-a").run();
    const seenByB = await envB.DB.prepare("SELECT id FROM __infra_probe ORDER BY id").all();
    expect(seenByB.results).toEqual([]);

    await envB.DB.prepare("INSERT INTO __infra_probe (id) VALUES (?)").bind("marker-b").run();
    const seenByA = await envA.DB.prepare("SELECT id FROM __infra_probe ORDER BY id").all();
    const seenByBAfterInsert = await envB.DB.prepare("SELECT id FROM __infra_probe ORDER BY id").all();
    expect(seenByA.results.map((row) => row.id)).toEqual(["marker-a"]);
    expect(seenByBAfterInsert.results.map((row) => row.id)).toEqual(["marker-b"]);
  });

  it("starts with fresh D1 storage after closing a harness", async () => {
    const first = await openHarness();
    const firstEnv = await first.worker.getEnv();
    await firstEnv.DB.prepare("CREATE TABLE __infra_probe (id TEXT PRIMARY KEY NOT NULL)").run();
    await firstEnv.DB.prepare("INSERT INTO __infra_probe (id) VALUES (?)").bind("old-marker").run();
    await first.close();
    sandboxes = sandboxes.filter((sandbox) => sandbox !== first);

    const second = await openHarness();
    const secondEnv = await second.worker.getEnv();
    const tables = await secondEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__infra_probe'",
    ).all();
    expect(tables.results).toEqual([]);
  });

  it("blocks outbound HTTP from an actual Worker execution", async () => {
    const before = blockedAttempts();
    const release = blockOutbound();
    const probe = createTestHarness({
      root,
      workers: [{
        config: {
          name: "liberait-outbound-probe",
          main: "testing/health/outbound-worker.mjs",
          compatibility_date: "2026-10-01",
          workers_dev: false,
          preview_urls: false,
          routes: [],
        },
      }],
    });
    try {
      await probe.listen();
      const response = await probe.fetch("http://localhost/outbound");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ blocked: true });
      expect(blockedAttempts()).toBe(before + 1);
    } finally {
      await probe.close();
      release();
    }
  });

  it("enforces origin, JSON, and customer/operator host boundaries without booking", async () => {
    const sandbox = await openHarness();
    const healthUrl = new URL("/api/health", sandbox.customerOrigin);
    const matchingOrigin = await sandbox.server.fetch(healthUrl, {
      method: "POST",
      headers: { Origin: sandbox.customerOrigin, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(matchingOrigin.status).toBe(404);

    const missingOrigin = await sandbox.server.fetch(healthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingOrigin.status).toBe(403);

    const wrongOrigin = await sandbox.server.fetch(healthUrl, {
      method: "POST",
      headers: { Origin: "http://example.invalid", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(wrongOrigin.status).toBe(403);

    const nonJson = await sandbox.server.fetch(healthUrl, {
      method: "POST",
      headers: { Origin: sandbox.customerOrigin, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(nonJson.status).toBe(403);

    const operatorRouteOnCustomerHost = await sandbox.server.fetch(
      new URL("/api/operator/blocked-slots", sandbox.customerOrigin),
      { headers: { "X-Local-Operator-Email": "local.operator@example.invalid" } },
    );
    expect(operatorRouteOnCustomerHost.status).toBe(404);
  });
});
