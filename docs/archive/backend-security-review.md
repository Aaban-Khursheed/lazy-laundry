# Lazy Laundry — Backend, Security & Build-Practicality Review

**Review date:** 2026-09-24  
**Scope:** Full source review of the `lazy-laundry/` static subproject plus the parent FS-Caravan Next.js repository and its Qimmat-site `AGENTS.md` rules where relevant. Liberait is the multi-project technology company; those rules describe the Qimmat public-site project, not the whole portfolio. The operator's stated model is a low-volume condo/neighborhood service run by an international student; Student Pass permission is a separate legal gate covered in `business-operations-review.md`. No application source files were changed. Severity labels below describe production launch priority, not a CVSS score. No penetration test or deployed-host configuration review was performed.

## Executive summary

**There is no server-side booking backend.** The application is a static HTML/CSS/JavaScript prototype. It validates form state in the browser, assembles an order object, writes it to the current browser’s `localStorage`, then displays a locally generated confirmation. No booking is sent to the business, no durable shared order record exists, and no customer-to-operator workflow exists.

As a visual prototype or local demo, this is practical and inexpensive. The current app is not suitable as a self-service live booking system: different customers can reserve the same apparent slot, the operator cannot see or fulfill orders, tracking is same-device only, and personal details remain in browser storage. At the stated low volume, a backend is not automatically the next step: **if paid activity is confirmed as permitted**, a capped manual intake/log and explicit operator confirmation may be enough for a pilot. Keep this app demo-only until its data and delivery issues are addressed. Add a small server-side booking boundary with shared slots and durable state when public automated intake or volume makes that worthwhile.

Liberait is a technology company with multiple projects, and Lazy Laundry is appropriate as one of those projects. The product/deployment boundary is narrower: this app serves an Edumetro/USJ 1, Malaysia laundry service with RM pricing, while the existing FS-Caravan/Qimmat public-site rules describe a Saudi/GCC premium furniture and caravan showroom. Keep Lazy Laundry distinct from that specific public site unless there is an explicit cross-product decision; this is not a mismatch with Liberait’s overall project portfolio.

## Booking and tracking data flow

1. Home and booking/tracking views are switched in the browser (`index.html:40-47`; `app.js:420-435`).
2. Dates, slots, prices, and validation are calculated client-side (`app.js:54-181, 234-324, 438-499`).
3. Checkout gathers customer name, phone, building/block, and unit into a JavaScript object (`index.html:215-264`; `app.js:500-528`).
4. Submission calls `preventDefault()` and appends the object to `localStorage` under `lazyLaundryBookings` (`app.js:196-206, 479-533`).
5. Confirmation uses the in-memory order object; tracking searches that same browser’s storage (`app.js:377-418, 459-477`).
6. New records always start with `STATUS_STEPS[0]`; there is no server, staff UI, or status transition mechanism (`app.js:16-23, 524`).

The project contains no API/serverless handler, database client, network submission, package manifest, test suite, or deployment manifest. The copied `functions/api` and `migrations` directories are empty.

## Production blockers

### P0 — Booking is never delivered to the operator — Confirmed

- The submit handler does not send an HTTP request (`app.js:479-533`); it only calls `saveBooking()` (`app.js:204-206, 530`).
- Staff receive no email, dashboard record, WhatsApp message, or other booking notification. The customer can see “Pickup confirmed” even though no operator has received anything.
- There is no audit trail, backup, failure queue, or recovery process.

**Production requirement:** persist a booking server-side and show customer confirmation only after the server acknowledges a durable save. Select an operator alert channel, delivery/retry policy, and fallback procedure before connecting a real provider.

### P0 — Slot availability is not shared or atomic — Confirmed

- “Booked” status is derived by scanning local browser storage (`app.js:228-232`), and submit-time checks use that same per-device data (`app.js:494-498`).
- Customers on separate devices have separate stores and can all book the same slot. Multiple tabs can also race through the read/append/write sequence (`app.js:204-206, 530`).
- The UI’s one-booking-per-slot rule is therefore not a business capacity guarantee.

**Production requirement:** keep authoritative slot inventory on the server and reserve capacity atomically. Decide whether capacity is one or more orders per slot; enforce that rule transactionally, handle retried requests idempotently, and calculate cutoffs in the service timezone using server time.

### P1 — Personal data is retained indefinitely in browser storage — Confirmed

- Name, phone, block, unit, full address, preferences, and timestamp enter the booking object (`app.js:503-527`). The form fields are in `index.html:215-264`.
- The complete booking is stored with `localStorage.setItem()` and has no expiry/deletion path (`app.js:196-206`). Tracking also prefills the latest booking number on navigation (`app.js:427-431`).
- Any script executing in the same origin can read local storage. Shared devices and browser profiles may expose prior order details. Storage is not an appropriate durable customer database.

**Production requirement:** minimize browser-side data, publish the required privacy information, define access/retention/deletion and incident procedures, and use a controlled server-side store with least-privilege staff access. Avoid putting full customer submissions in logs or analytics.

### P1 — Tracking has no shared record or live status — Confirmed

- Lookup searches only the current browser’s local array (`app.js:459-477`). Clearing storage or switching devices loses the booking.
- Every order receives “Booking received”; no code changes it (`app.js:524`). “Processing,” “Ready,” and “Delivered” are never reached by the UI itself.

**Production requirement:** create a staff-controlled status workflow with status timestamps/history. Customer tracking should use an authenticated view or a separate unguessable token; a human-readable booking number alone must not authorize access to address/order data.

### P1 — IDs are guessable and not globally unique — Confirmed design limitation

- Booking IDs are random four-digit values (`LL-1000` through `LL-9999`) generated by `Math.random()` and checked only against the current device’s saved bookings (`app.js:208-215`).
- Collisions across devices are possible, and the short code is enumerable. This is currently limited by local-only lookup but is unsuitable as a production identifier or tracking credential.

**Production requirement:** issue IDs server-side with a database uniqueness constraint. Keep a human-readable order number separate from any high-entropy tracking/authorization token.

### P1 — Pricing and validation are client-controlled — Confirmed

- Pricing and totals are computed in downloadable JavaScript (`app.js:1-14, 148-181, 307-324`). Form/slot checks run in the browser (`app.js:438-499`).
- A customer can alter browser state or send modified input; no server verifies package, extras, price, terms, payment choice, date, slot, or address. Client-side validation is useful for UX but cannot protect order integrity.

**Production requirement:** treat every field as untrusted; validate allowed values and recalculate prices/eligibility/capacity on the server. Return the saved server-generated booking result rather than treating the client’s displayed total as authoritative.

### P1 — Date, weekend, and expiry use the customer device’s clock/timezone — Confirmed

- “Today,” date range, weekend detection, and slot expiry use browser-local `Date` values (`app.js:54-72, 217-226, 535-537`).
- The service is described as Edumetro/USJ 1, but the app does not anchor scheduling to `Asia/Kuala_Lumpur` or a server clock.

**Production requirement:** make the business timezone explicit and enforce date limits/cutoffs on the server.

## Additional security and reliability findings

### P2 — Malformed storage can break core interactions — Confirmed robustness issue

`readBookings()` catches JSON parse errors but accepts any valid JSON shape (`app.js:196-202`). Later code assumes an array for `.map()`, `.some()`, `.find()`, and spread (`app.js:205, 209, 228-232, 461`). Manually altered or corrupted data can break slot rendering, navigation, tracking, or booking. The storage write itself is not caught, so unavailable/full storage can interrupt confirmation (`app.js:204-206, 530`).

**Prototype improvement:** validate parsed data and show a recoverable save error. **Production direction:** move booking persistence to the server, not add more client-side recovery around persistent personal data.

### P2 — No remotely exploitable XSS was found in this source review; dynamic HTML remains a maintenance risk

The code has several `innerHTML` sinks (`app.js:127, 252, 273, 321, 323, 385-397, 403-417`) and an `escapeHtml()` helper (`app.js:187-194`). User-controlled address, service, number, date, extras, and status are generally escaped before rendering. No confirmed remote injection path was identified in the current three-file app.

Residual risks: `booking.packageSize` is interpolated without escaping in confirmation markup (`app.js:387`); stored records are not schema-validated; and future additions can accidentally insert an unescaped field. Prefer DOM construction/`textContent` for dynamic values and schema-validate any record before rendering. Add a Content Security Policy and other security headers at the eventual hosting boundary.

### P2 — Terms checkbox is a placeholder, with no auditable acceptance record

The checkout asks customers to agree to terms/privacy policies, but the links are plain text and the details state that final wording will be added later (`index.html:266-278`). The current `termsAccepted` value is only stored in local browser data (`app.js:522`). Publish real policies before collecting live details; if acceptance is required, record the policy version/time with the server-side order.

### P2 — No cancellation, correction, support, or failure recovery

There is no path to cancel or correct an order, contact support from confirmation/tracking, recover a lost booking, or route a failed notification (`index.html:323-355`). Define these operational actions before real orders are accepted.

## Build and deployment practicality

### What is practical now

- The app is exactly three required static source files: `index.html`, `styles.css`, and `app.js`.
- There are no packages or build tools in `lazy-laundry/`; a simple static host can serve it cheaply, with no application server needed for a **demo**.
- Static load should be small and fast: no remote assets, third-party code, or network requests. No deployed performance test was run.

### What the current FS-Caravan Next.js build does not provide

- The Lazy Laundry folder sits at this repository root, outside its `src/app` route tree and outside `public/`. It is not automatically a Next.js App Router page or a public asset at `/lazy-laundry`.
- This repository’s `npm run build` validates the Qimmat Next.js site; it will not exercise the standalone prototype’s booking interactions. There is no Lazy Laundry lint/test/build script or deployment config.
- The existing Qimmat public-site rules target a Saudi/GCC furniture/caravan showroom; Lazy Laundry targets a service in Malaysia with RM prices and a booking flow. This distinction matters if the two projects share a public site or deployment, not as a reason to exclude Lazy Laundry from Liberait’s portfolio.

**Practical choices:** keep the project in its own folder within Liberait’s multi-project workspace and give it a separate static demo/host; or deliberately integrate it as a distinct route/app after deciding how it should coexist with the Qimmat site. A folder copy alone is not route integration.

## Recommended technical path by phase

### Authorized low-volume pilot

First resolve the Student Pass and condo/tenancy gates documented in `business-operations-review.md`. If the paid activity is allowed, a one-person pilot can remain manual: offer only a few confirmed pickup windows, record the minimum order details in a restricted operator-controlled log, confirm each order directly, and keep a separate backup/reconciliation routine. A dashboard, CMS, database, and custom backend may be unnecessary at this stage.

This does **not** make the current web form suitable for taking live orders. It saves personal details only in the customer's browser and sends nothing to the operator. Either keep it as a demo or replace/disable the submission flow before inviting real customers; do not treat its “Pickup confirmed” screen as an actual operator acknowledgement.

### Scale-up / automated booking

When self-service public orders, multiple operators, higher volume, or real-time shared capacity justify software, use a small server-side booking API plus durable shared persistence. A CMS or general-purpose always-on server is not automatically required. Before selecting a platform/provider, decide:

1. The data fields and business rules (service area, slots/capacity, timezone, cutoff, pricing, promotion, cancellations).
2. The authoritative booking/slot store and atomic reservation rule.
3. Operator notification and status-update workflow, with retries and manual recovery.
4. Customer tracking authorization and what details may be disclosed.
5. Privacy notice, retention/deletion schedule, access control, and incident response.
6. Whether payment remains at pickup or becomes an explicit, separately scoped provider integration.

At that stage, server-side validation, access controls, rate limiting/abuse controls, idempotent submission, backups, monitoring, HTTPS, CSP/security headers, and tests for concurrent reservations and failure paths are production requirements. Do not add CRM, WhatsApp API, analytics, or payments without a clear product/provider decision.

## Overall assessment

| Use case | Assessment |
|---|---|
| Design review / local demo | **Suitable.** Lightweight and easy to serve. Clearly label bookings/tracking as simulated. |
| Small condo/neighborhood pilot with manual intake | **Potentially practical only after written Student Pass and condo/tenancy checks.** Use an operator-controlled minimal log and explicit confirmation; the current app is not that workflow. |
| Automated bookings through this app | **Not suitable as-is.** No business-visible order, shared availability, authoritative pricing, live status, or data operations exist. |
| Public information page with no real order intake | **Possible** after content, brand, privacy, and deployment review. |
| Inclusion in Liberait’s project portfolio | **Appropriate.** Lazy Laundry is one of Liberait’s projects; keep its code/deployment bounded as needed. |
| Integration into the Qimmat public website | **Separate product decision.** Different service, audience, geography, and currency; the current Qimmat site rules apply to that public site, not to Liberait’s entire portfolio. |
