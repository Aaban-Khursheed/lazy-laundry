# Lazy Laundry project rules

## Scope

- This repository is the canonical Lazy Laundry project for `Aaban-Khursheed/lazy-laundry`.
- Do not modify unrelated accounts, repositories, or identities, including `Dannny-101` and `tenandseeagency`.
- Public booking intake is open by owner decision (2026-10-19). `PUBLIC_BOOKING_ENABLED` in `wrangler.jsonc` must match production; change it only on the owner's instruction (it is the emergency stop; see README).

## Architecture

- The single Worker entrypoint is `api/worker.js` and serves `public/` assets plus same-origin APIs.
- Customer traffic uses `lazylaundry.me` and `www.lazylaundry.me`; operator traffic uses `ops.lazylaundry.me`.
- Local development uses the `local` Wrangler environment and local D1 only. Never use `--remote` for local tests.
- Production secrets belong in scoped Wrangler/Cloudflare secrets, not source, committed variables, logs, tests, or chat.

## Validation commands

Run from this directory:

```text
npm ci
npm run lint
npm run test
npm run test:e2e
npm run deploy:dry-run
```

Start local development with:

```text
npm run dev
```

The local Worker listens on `http://localhost:8787`. Local operator smoke tests use the explicitly local-only identity configured in the local Wrangler environment; that path must never be accepted in production.

## Data and security

- D1 migrations are append-only: add a new `api/migrations/NNNN_name.sql` file per change, never edit an applied file. Applied migrations are not undone by Worker rollback. `npm run db:check` gates ordering and flags destructive statements (`DROP`, `RENAME`, `DELETE`, `UPDATE`, `REPLACE INTO`) that lack a recorded review.
- Use parameterized SQL, integer sen values, guarded batch writes, revision checks, and the unique active pickup-slot constraint.
- Customer tracking responses must not expose name, phone, block, unit, notes, penalties, or operator identity.
- Tracking credentials are bearer secrets: keep them in URL fragments only, never in API URLs, logs, storage, exports, or cacheable responses.
- Operator alert emails go only to the binding's pinned `destination_address`; they may carry customer PII the operator needs but must never include tracking tokens. Alert delivery is best-effort (`ctx.waitUntil`, one transient retry): it must never block, delay, or fail a customer request, and failures log `operator_alert_failed` without PII.
- Public mutations require same-origin JSON requests and server-side Turnstile verification in production. Configure the `RATE_LIMITER` binding before public intake; rate limiting is an abuse control, not authoritative accounting.
- Operator access requires Cloudflare Access plus Worker-side JWT verification in production.
- Intake is open. Bilingual (BM/EN) Terms and Privacy Notice are published at `/legal/` and `TERMS_POLICY_VERSION` is `launch-v2`; any policy change bumps that version.

## UI architecture

- The customer app is mobile-only in layout: `public/booking/styles.css` imports its layout, booking, and tracking modules. Desktop browsers retain a centered phone-width preview, not a second desktop customer layout.
- The operator app is a desktop workspace at widths of 1024px and above. Smaller screens show a device-size notice without loading bookings; resizing smaller clears private UI state. This is a usability guard, not authorization.
- JavaScript source lives in `src/` and is never shipped: `src/booking/` (customer app + modules), `src/operator/` (operator app + modules), `src/shared/` (browser modules). `npm run build:ui` bundles the two entry points into the ignored minified assets `public/booking/app.js` and `public/operator/app.js` — those bundles are the only JS the Worker serves. Readable module files must never be added under `public/`.
- Operator rendering, API actions, dashboard state, and native action dialogs live under `src/operator/modules/`. Operator assets must never be served on customer hosts. Lifecycle/payment PATCH requests must include the displayed positive integer `revision`; the Worker rejects stale revisions before guarded writes.
- Shared design tokens, base rules, and component styles live under `public/shared/` (CSS ships as files). API helpers, presentation constants, and formatting utilities are shared browser modules under `src/shared/`; customer compatibility reexports (`src/booking/modules/api.js`, `constants.js`, `utils.js`) must not contain operator UI.
- Actual Class Variance Authority definitions live in `src/shared/variants.js`. Use the shared button, badge, and surface variants instead of creating ad hoc intent/size styling.
- `npm run build:ui` bundles the app entry points (inlining CVA) into the ignored minified `public/booking/app.js` and `public/operator/app.js` assets using the pinned local esbuild. The dev, browser-test, deployment, and dry-run scripts build them automatically. After editing any `src/` file during a running dev session, rebuild or use `npm run build:ui -- --watch` in a second terminal.
- Keep scripts and styles same-origin and external; do not weaken CSP for UI changes. Tracking links remain memory-only and must not appear in logs or browser storage.
- Browser UI tests use synthetic API fixtures, plus the existing local D1 integration test. Validate customer widths of 320–480px, desktop preview, operator widths of 1024px and above, and the operator small-screen guard.

## Mandatory launch baseline

- Improve and verify the apps against local D1 before production setup. A later authorized protected deployment is for production-binding acceptance, not a substitute for working UI. Intake is open by owner decision; every baseline item below remains mandatory for each release.
- Operator density: preserve the sidebar and header. The queue is a card grid (ten orders per page, five across at 1440px and wider, fewer columns at narrower desktop widths); order details open in an on-demand modal drawer with Overview/Booking/Activity tabs instead of a permanent detail panel. At 1280×800, the card grid and an open order's primary lifecycle/payment controls must be visible without page scrolling. Card content stays readable — pickup date/time must never be clipped into ambiguity — and not reduced to tiny text. The drawer must support Escape, warn before discarding unsaved notes, restore focus to the triggering card control, and preserve queue context (filters, page, scroll position). Put tracking administration, notes/history, fee details, and operational explanations behind accessible disclosures in the Activity tab.
- Operator discovery: status filtering, search, and pagination must query the database, not silently stop at the first 50 records. Display the result range and total; keep summary and export scope explicit. SQL search is bounded and parameterized, and must not put phone/name/location searches in GET URLs or logs.
- Operator integrity: prevent parallel writes, require audit reasons for exceptional actions, reject stale revisions, preserve note drafts and disclosure state across same-order refresh, and explicitly warn before discarding unsaved notes. Private tracking links remain memory-only and clear on order switch, close, or small-screen transition.
- Customer completion: selecting a slot, reviewing the server quote, submitting, receiving confirmation, copying a private link, tracking, cancellation, and repeated eligible rescheduling must all work on mobile without requiring a reload. Preserve form data on recoverable errors. If quote loading changes the displayed total, show the updated amount and fees for explicit review before sending a booking POST.
- Request recovery: bound configuration, Turnstile script/widget, API, and CSV waits. Restore controls on every terminal path. Do not silently retry mutations or claim no booking was created after a lost response; unchanged ambiguous booking retries must reuse the original key and payload. Serialize submission from the beginning of quote preparation, not only the final POST.
- Accessibility and layout: no horizontal page overflow at 320/390/480px customer and 1024/1280/1440px operator widths; customer input fonts at least 16px and tap targets at least 44px. Label controls, preserve keyboard focus, support Escape/cancel on dialogs and reduced motion, and keep destructive actions distinct from primary work.
- Baseline verification must include happy paths and delayed/offline/error paths, duplicate-submit prevention, quote conflicts, empty/search/paged queues, stale-update recovery, unsaved-note behavior, repeated rescheduling, credential handling, and host isolation. Passing mocked UI tests does not replace D1 concurrency/fee tests, physical mobile-browser acceptance, or real Access/Turnstile verification.
- No unresolved booking-loss, double-write, payment/fee inconsistency, privacy leak, or blocked-recovery defect is acceptable for launch. Record unmet baseline checks honestly; do not equate a build or test count with production readiness.
