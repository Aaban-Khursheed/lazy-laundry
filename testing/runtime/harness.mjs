import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { blockOutbound } from "./outbound.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = fileURLToPath(
  new URL("../wrangler.test.jsonc", import.meta.url),
);

export async function startHarness({ customerOrigin } = {}) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const allowed = new Set([
    "$schema", "name", "main", "compatibility_date", "workers_dev",
    "preview_urls", "routes", "assets", "vars", "secrets", "d1_databases",
    "ratelimits",
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key))
    || config.vars?.ENVIRONMENT !== "local"
    || config.vars.CUSTOMER_HOSTS !== "localhost,127.0.0.1"
    || config.vars.OPERATOR_HOST !== "ops.localhost"
    || config.routes?.length !== 0
    || config.workers_dev !== false
    || config.preview_urls !== false
    || config.secrets?.required?.length !== 1
    || config.secrets.required[0] !== "TRACKING_TOKEN_ENCRYPTION_KEY"
    || config.d1_databases?.length !== 1
    || config.d1_databases[0].remote !== false
    || config.d1_databases[0].database_id !== "liberait-test-only") {
    throw new Error("Refusing a non-isolated test configuration");
  }
  const release = blockOutbound();
  const secrets = {
    TRACKING_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  };
  const workerOptions = (origins = {}) => ({
    configPath,
    vars: { ...config.vars, ...origins },
    secrets,
  });
  const server = createTestHarness({ root, workers: [workerOptions()] });
  const close = async () => {
    try { await server.close(); } finally { release(); }
  };
  try {
    const { url } = await server.listen();
    const origin = customerOrigin ?? url.origin;
    const match = /^http:\/\/(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(origin);
    if (!match || Number(match[2]) > 65535) {
      throw new Error("Only an explicit loopback HTTP origin is allowed");
    }
    const operatorOrigin = `http://ops.localhost:${match[2]}`;
    await server.update({
      root,
      workers: [workerOptions({
        CUSTOMER_ORIGIN: origin,
        OPERATOR_ORIGIN: operatorOrigin,
      })],
    });
    if ((await server.listen()).url.origin !== url.origin) {
      throw new Error("Runtime URL changed while configuring origins");
    }
    const worker = server.getWorker();
    await worker.applyD1Migrations("DB");
    const response = await server.fetch(new URL("/api/health", url));
    if (response.status !== 200 || (await response.json()).status !== "ok") {
      throw new Error("Isolated Worker/D1 readiness failed");
    }
    return { server, worker, url, customerOrigin: origin, operatorOrigin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
