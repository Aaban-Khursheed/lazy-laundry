import { expect, test } from "@playwright/test";

const BASE = "http://localhost:8787";
const OPS = "http://ops.localhost:8787";

const PAGES = [
  { path: "/legal/terms", marker: "Terms of Service" },
  { path: "/legal/privacy", marker: "Personal Data Protection Notice" },
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
});

test.describe("legal content", () => {
  for (const { path } of PAGES) {
    test(`${path} contains no draft placeholder text`, async ({ request }) => {
      const body = await (await request.get(`${BASE}${path}`)).text();
      expect(body).not.toContain("Draft pending approval");
      expect(body).not.toContain("intake remains disabled");
    });
  }

  test("terms name the operator, cap, and contact", async ({ request }) => {
    const body = await (await request.get(`${BASE}/legal/terms`)).text();
    expect(body).toContain("Aaban Khursheed");
    expect(body).toContain("privacy@lazylaundry.me");
    expect(body).toContain("601115758561");
    expect(body).toContain("10× the service price");
    expect(body).toContain("launch-v2");
    // Bahasa Malaysia section present
    expect(body).toContain("Terma Perkhidmatan");
  });

  test("privacy notice is bilingual and PDPA-complete", async ({ request }) => {
    const body = await (await request.get(`${BASE}/legal/privacy`)).text();
    expect(body).toContain("Personal Data Protection Act 2010");
    expect(body).toContain("Akta Perlindungan Data Peribadi 2010");
    expect(body).toContain("Notis Perlindungan Data Peribadi");
    expect(body).toContain("Aaban Khursheed");
    expect(body).toContain("privacy@lazylaundry.me");
    expect(body).toContain("Cloudflare");
  });

  test("pickup & delivery policy states the real service rules and contacts", async ({ request }) => {
    const body = await (await request.get(`${BASE}/legal/pickup-delivery`)).text();
    expect(body).toContain("RM3.00");
    expect(body).toContain("Edumetro");
    expect(body).toContain("10 minutes");
    expect(body).toContain("601115758561");
  });
});
