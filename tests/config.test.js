import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));

describe("deployment configuration contract", () => {
  it("keeps public intake open in committed production config (owner decision 2026-10-19; change only on the owner's instruction and update README)", () => {
    expect(config.vars.PUBLIC_BOOKING_ENABLED).toBe("true");
  });

  it("never configures the local operator bypass in production", () => {
    expect(config.vars.ENVIRONMENT).toBe("production");
    expect(config.vars).not.toHaveProperty("LOCAL_OPERATOR_EMAIL");
  });

  it("keeps the local environment off production routes and data", () => {
    expect(config.env.local.vars.ENVIRONMENT).toBe("local");
    expect(config.env.local.routes).toEqual([]);
    expect(config.env.local.d1_databases[0].database_id).toBe("local");
  });
});
