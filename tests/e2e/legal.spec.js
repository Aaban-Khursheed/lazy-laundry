import { expect, test } from "@playwright/test";

const BASE = "http://localhost:8787";
const OPS = "http://ops.localhost:8787";

const PAGES = [
  { path: "/legal/terms", marker: "Terms" },
  { path: "/legal/privacy", marker: "Privacy" },
  { path: "/legal/pickup-delivery", marker: "Pickup" },
];

test.describe("legal page routing", () => {
  for (const { path, marker } of PAGES) {
    test(`${path} serves the page with and without a trailing slash`, async ({ request }) => {
      for (const url of [path, `${path}/`, `${path}/index.html`]) {
        const response = await request.get(`${BASE}${url}`);
        expect(response.status(), url).toBe(200);
        expect(await response.text(), url).toContain(marker);
      }
    });
  }

  test("unknown legal paths still 404", async ({ request }) => {
    for (const url of ["/legal/does-not-exist", "/legal/"]) {
      const response = await request.get(`${BASE}${url}`);
      expect(response.status(), url).toBe(404);
    }
  });

  test("legal pages are not served on the operator host", async ({ request }) => {
    const response = await request.get(`${OPS}/legal/terms`);
    expect(response.status()).toBe(404);
  });

  test("checkout links point at real terms, pickup & delivery, and privacy pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    for (const path of ["/legal/terms", "/legal/pickup-delivery", "/legal/privacy"]) {
      expect(await page.locator(`.terms-card a[href="${path}"]`).count(), path).toBeGreaterThanOrEqual(1);
    }
  });

  test("pickup & delivery policy states the real service rules", async ({ request }) => {
    const response = await request.get(`${BASE}/legal/pickup-delivery`);
    const body = await response.text();
    expect(response.status()).toBe(200);
    expect(body).toContain("RM3.00");
    expect(body).toContain("Edumetro");
    expect(body).toContain("10 minutes");
  });
});
