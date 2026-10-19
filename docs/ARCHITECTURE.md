# Lazy Laundry — Technical Architecture

Last verified against source: 2026-10-18. When behavior and this document
disagree, the source wins — update this file.

## System context

```
                         lazylaundry.me / www.lazylaundry.me
                                    │
            ┌───────────────────────┼────────────────────────┐
            │                       │                        │
   Customer browser          Customer browser          Operator browser
   (booking + tracking)      (booking + tracking)      (ops.lazylaundry.me)
            │                       │                        │
            └───────────────────────┼────────────────────────┘
                                    │  HTTPS, same-origin only
                    ┌───────────────▼───────────────┐
                    │   Cloudflare Worker           │
                    │   api/worker.js               │
                    │   host role → asset or API    │
                    └───┬───────────┬───────────┬───┘
                        │           │           │
                 Workers Assets     D1      Turnstile siteverify
                 (public/,          (SQLite)  Cloudflare Access
                 per-role prefix)             certs (ops JWT)
```

One Worker serves everything. There is no separate frontend host, API service,
or CDN config to drift out of sync.

## Host-role model — the outermost boundary

Every request is classified by hostname before anything else runs
(`hostRole`, `api/worker.js`):

| Hostname | Role | Gets |
|---|---|---|
| `lazylaundry.me`, `www.lazylaundry.me` (local: `localhost`, `127.0.0.1`) | customer | `/booking/`, `/shared/`, `/legal/` assets + public API |
| `ops.lazylaundry.me` (local: `ops.localhost`) | operator | `/operator/`, `/shared/` assets + `/api/operator/*` |
| anything else (incl. `*.workers.dev`) | none | 404 |

Asset prefixes are enforced per role before the assets binding is fetched —
operator code can never be served on a customer host. `/` rewrites to the
role's `index.html`. The isolation invariant is tested against real shipped
files in `tests/worker.test.js`.

## Request pipeline

1. `hostRole` → 404 for unknown hosts.
2. CORS: reflect only allowlisted origins (`CUSTOMER_HOSTS`, `OPERATOR_HOST`,
   optional `CUSTOMER_ORIGIN`/`OPERATOR_ORIGIN`, localhost in local env);
   unknown origin → 403.
3. `OPTIONS` → 204 with security headers.
4. Non-`/api/` → `serveAsset` (operator pages additionally require a verified
   Access JWT in production).
5. `/api/` mutations require same-origin `Origin`, `Sec-Fetch-Site:
   same-origin|none`, and `Content-Type: application/json`
   (`mutationRequestError`).
6. `/api/operator/*` on customer host → 404; customer API on ops host → 404.

## Public API (customer hosts)

| Endpoint | Guards | Notes |
|---|---|---|
| `GET /api/health` | — | D1 `SELECT 1` liveness |
| `GET /api/config` | — | `bookingEnabled`, `priceRevision`, `turnstileSiteKey`, `bookingLeadMinutes` |
| `GET /api/availability?date=` | rate limit | booked slots; KL date, 7-day window |
| `POST /api/estimate` | rate limit + Turnstile(`estimate`) | server-authoritative quote incl. outstanding penalty fees + promo preview |
| `POST /api/bookings` | rate limit + Turnstile(`booking`) + `X-Idempotency-Key` + `PUBLIC_BOOKING_ENABLED` | transactional slot reservation, see below |
| `POST /api/track` | rate limit | booking number + tracking token (hash-compared); PII-stripped response |
| `POST /api/bookings/:num/cancel` | rate limit + Turnstile(`cancel`) + token + phone | late-cancel penalty logic |
| `POST /api/bookings/:num/reschedule` | rate limit + Turnstile(`reschedule`) + token + phone | slot re-reservation |
| `POST /api/bookings/:num/edit` | rate limit + Turnstile(`edit`) + token + phone | detail edits with repricing |

## Operator API (ops host only, Access JWT + email allowlist)

| Endpoint | Notes |
|---|---|
| `GET /api/operator/bookings`, `POST …/search` | DB-backed filter/search/paginate |
| `GET /api/operator/export` | CSV, rate-limited, formula-injection escaped |
| `GET /api/operator/bookings/:id` | detail + events + notes + penalties |
| `PATCH /api/operator/bookings/:id` | lifecycle/payment/reschedule/cancel; requires `revision`; audit reasons for exceptional actions; guarded batch writes |
| `POST …/notes` | private operator notes |
| `POST …/share\|rotate\|revoke` | tracking-token lifecycle (re-encrypts stored token) |
| `POST /api/operator/penalties/:id/waive` | waive penalty with audit |
| `GET/POST /api/operator/promotions`, `PATCH …/:id` | promo CRUD + events |

## Data model (D1)

- **bookings** — id (uuid), `booking_number` (`LL-XXXXXXXX`, human),
  `tracking_token_hash` (lookup key), `encrypted_tracking_token` +
  `tracking_token_key_version` (re-issuance only), `idempotency_key_hash` +
  `request_payload_hash` (safe retry), `customer_id` FK, customer snapshot
  fields, package/service/options, `pickup_date`/`pickup_slot`,
  `service_total_cents`/`fee_total_cents`/`discount_cents`/`total_cents`
  (integer sen), `payment_method`/`payment_status`, `status`, cancellation
  reason/actor/at, `ready_at`, `revision` (optimistic concurrency), terms
  acceptance + policy version, `promo_code`, `operator_reminded_at`
  (pre-pickup reminder digest dedupe), `customer_anonymized_at` (retention).
  - **Key constraint:** `bookings_one_active_per_pickup_slot` — partial
    unique index on `(pickup_date, pickup_slot) WHERE status <> 'cancelled'`.
    Double-booking is impossible below the application layer.
- **customers** — phone-keyed (`customer-<digits>`), `penalty_balance_cents`.
- **booking_events** — status/payment/edit transitions (audit trail).
- **booking_audit_events** — creation, edits, operator actions, details_json.
- **penalty_events** — `outstanding → allocated → settled|waived`; one
  incident per booking per reason (`0004` unique guard). Outstanding balances
  allocate onto the customer's next booking as `fee_total_cents`.
- **operator_notes** — private, ≤2000 chars.
- **promotions + promotion_events** — percent/fixed codes, min spend, max
  redemptions, active window; discount applies to service total only.

Migrations (`api/migrations/`) are additive and **not undone by rollback**.

## Booking creation — the transactional core

`createBooking` ordering (`api/worker.js`):

1. rate limit → Turnstile → idempotency-key format → payload validation.
2. Idempotent replay (IETF Idempotency-Key draft semantics): the fingerprint is the SHA-256 of the canonical client-supplied fields only, never server-derived values such as `readyAt` or totals. Same key + same fingerprint → 201 with the stored booking and the re-issued token; same key + different fingerprint → 422 `idempotency_key_reused`.
3. `PUBLIC_BOOKING_ENABLED` gate (503 when off) → slot window check: KL date within 7 days and pickup at least `BOOKING_LEAD_MINUTES` (default 60) away; the operator may use any slot that has not started.
4. One `env.DB.batch`: customer upsert → penalty-balance zero guarded by
   `changes()=1` → booking `INSERT … WHERE` slot/promo/balance guards → promo
   redemption increment → penalty allocation → status + audit events.
5. Any unique-constraint violation first re-runs the replay lookup, so an overlapping identical retry that lost the race receives the winner's booking. Only when no booking exists for the key does a `(pickup_date, pickup_slot)` violation return 409 `slot_taken`.
6. `expectedTotalCents` / `priceRevision` mismatch → 409 `quote_changed` —
   the client must re-show the server quote before retrying.
Error codes: `quote_changed` (409, includes fee-balance changes), `slot_taken` (409), `slot_unavailable` (409), `idempotency_key_reused` (422).

## Tracking-token model

- 256-bit random, base64url (43 chars). Customer-facing only via URL
  `#fragment` (never sent in requests, stripped by `history.replaceState`
  on arrival — `src/booking/app.js`).
- Stored as SHA-256 hash for lookup; AES-256-GCM ciphertext (key versioned,
  AAD = `id:booking_number`) solely so operator `share`/`rotate` and
  idempotent replay can re-issue the original token.
- `revoke`/`rotate` change the stored hash+ ciphertext; old tokens die.
- Tokens never appear in logs, API URLs, storage, or cacheable responses.

## Operator alerts

- `send_email` binding `EMAIL` pinned by `destination_address` to the single
  operator inbox — the Worker can never send elsewhere.
  `OPERATOR_ALERT_EMAIL` mirrors that address for `send()`'s `to` field.
- Instant alerts (`booking_created`, `customer_cancelled`,
  `customer_rescheduled`, `customer_booking_edited`) send inside
  `ctx.waitUntil` after the write commits; idempotent replay does not
  re-alert. Transient `E_*` codes retry once; final failure logs
  `operator_alert_failed` (no PII) and never affects the response.
- Cron `*/15 * * * *` → `scheduled()` → digest of `confirmed` bookings with
  pickup starting within 90 min and `created_at` older than 30 min; rows are
  stamped `operator_reminded_at` only after a successful send, so each
  booking reminds once and a failed send retries next tick. `LIMIT 50`.
- Emails carry the fields the operator needs (address, phone, `wa.me`,
  service, total); tracking tokens are never included.
- The same cron runs the retention pass (`runRetentionPass`): terminal
  bookings (`delivered`/`cancelled`) whose `updated_at` is over 24 months old
  have `customer_name`/`phone`/`block`/`unit` replaced with sentinels,
  `customer_anonymized_at` stamped, audit `details_json` nulled (it holds
  edit from/to PII), and `operator_notes` deleted (free text). Once none of a
  customer's bookings remain identifiable, an `anon-<id>` replacement row is
  inserted, children (`bookings`, `penalty_events` — note nulled,
  `booking_audit_events`) repointed, and the original row deleted — freeing
  the natural `customer-<digits>` id and phone so a returning customer can
  re-book (the upsert conflicts on `phone_e164` only). Customers with an
  outstanding `penalty_balance_cents` are skipped entirely — the notice
  excepts records needed for an unresolved fee. `LIMIT 25` per pass;
  failures log `retention_pass_failed`. This fulfils the privacy notice's
  24-month retention promise while keeping order/financial history.

## Operator authentication

`verifyOperator`: local env → `X-Local-Operator-Email` header matching
`LOCAL_OPERATOR_EMAIL` (requires `ENVIRONMENT=local` AND local hostname —
never accepted in production). Production → `Cf-Access-Jwt-Assertion` JWT:
RS256 + `kid`, signature verified against `https://<team>.cloudflareaccess.com
/cdn-cgi/access/certs` JWKS (per-isolate cache: 10-min TTL, unknown-kid
refetch floor 30s), `iss`/`aud`/`exp`/`nbf` checked, then email allowlist.
Failure classes: `unconfigured`→503, `unavailable`→503, `forbidden`→403,
else→401. Cloudflare Access at the edge is the first wall; the Worker check
is the second, independent one.

## Build pipeline

- Source: `src/{booking,operator,shared}/` (+ CVA in `src/shared/variants.js`).
  CSS ships as files under `public/`.
- `npm run build:ui` (esbuild, pinned): bundles the two app entries →
  minified `public/booking/app.js`, `public/operator/app.js` (gitignored,
  generated). Readable module files must never be added under `public/`.
- `predev` / `pretest:e2e` / `predeploy*` all auto-build. During `npm run
  dev`, edit `src/` then rebuild or run `npm run build:ui -- --watch`.

## Security headers

CSP `default-src 'self'` + `script-src 'self' https://challenges.cloudflare.com`
(Turnstile only), no inline anything; `frame-ancestors 'none'`, `object-src
'none'`, `base-uri 'none'`; `X-Frame-Options: DENY`; `nosniff`;
`Referrer-Policy: no-referrer` on operator, `strict-origin-when-cross-origin`
elsewhere; `Permissions-Policy` off; `Cache-Control: no-store` on API;
HSTS `max-age=15552000; includeSubDomains` (evaluate `preload` consciously —
it is effectively permanent).

## Failure-mode contract

- **Every** route wrapped → 503 + structured `console.error` event (see
  README watch list) — errors never leak internals.
- Fail-closed everywhere: missing `RATE_LIMITER` binding → 503 in prod;
  missing `TURNSTILE_SECRET` → 403; missing token key → 503; missing Access
  config → 503.
- Ambiguous client outcomes (`outcomeUnknown` on 5xx mutations) → UI locks
  and requires authoritative refresh; identical retry reuses the original
  idempotency key + payload byte-for-byte.
- Stale `revision` → 409, changes locked until refresh; note drafts and
  disclosure state survive same-order refresh.
- Rate limiting is an abuse control, not accounting — it is per
  `route:ip` at 100 req/60s.

## Frontends

- **Customer** (`src/booking/`): mobile-only layout; desktop shows a centered
  phone-width preview. `app.js` orchestrates views (booking/checkout/
  tracking/confirmation) with focus management; config gate reads
  `/api/config` before enabling intake; serialized submission from quote
  preparation onward.
- **Operator** (`src/operator/`): desktop workspace ≥1024px; smaller screens
  get a notice and private state is suspended/cleared (usability guard, not
  auth). Queue card grid (10/page) + modal drawer (Overview/Booking/Activity);
  draft preservation via `suspendedDraft`; action locking on 409/unknown.
- **Shared** (`src/shared/`): `api.js` (origin enforcement, timeout/abort,
  `outcomeUnknown`), `constants.js` (display-only labels — server is
  authoritative), `utils.js`, `variants.js` (CVA).
- `public/shared/` holds CSS only (tokens/base/components/styles).

## Decision records (why things are the way they are)

1. **Single Worker + same-origin** — no CORS surface between app and API;
   host-role gating makes host isolation enforceable in one place.
2. **Source never shipped** — only minified bundles in `public/`; readable
   source stays in `src/` (visibility is inherent to the web; the security
   boundary is the Worker, not hidden code).
3. **Intake flag committed to match production (currently ON, owner decision 2026-10-19)** — the repo is the source of truth, so a deploy can never silently change intake; the flag doubles as the emergency stop (README).
4. **Bearer tracking token, not login** — lowest-friction for one-off
   customers; phone cross-check on mutations adds a second factor of
   knowledge.
5. **Penalty via next booking** — no payment rails needed to collect fees;
   the next order carries `fee_total_cents`.
6. **One booking per slot** — capacity is a schema constraint, not app logic.
7. **Idempotent bookings** — flaky networks must never create duplicates;
   identical retry replays the stored result including the token.
8. **JWT verify in Worker despite Access at edge** — defense in depth; the
   Worker cannot assume the edge config is correct.
9. **No sourcemaps shipped** — matches the bundle-not-source posture.
10. **Rate-limit missing binding fails closed in prod, open in local** —
    abuse control must degrade toward "deny" publicly and "allow" for dev.

## Launch gates (Gate 1 — business/legal, outside code)

See `AGENTS.md` "Mandatory launch baseline" and `README.md`. Status (2026-10-19): intake is open by owner decision. Production secrets
`TURNSTILE_SECRET`, `TRACKING_TOKEN_ENCRYPTION_KEY`, `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` are present (verified with `wrangler secret list`). Open items:
approved bilingual legal pages, real-device acceptance.
