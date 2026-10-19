# Lazy Laundry

Pickup-and-delivery laundry service for Edumetro / USJ 1, Subang. One Cloudflare
Worker (`api/worker.js`) serves two static apps plus a same-origin JSON API on D1:

- `lazylaundry.me` / `www.lazylaundry.me` — customer booking + tracking app (`public/booking/`)
- `ops.lazylaundry.me` — operator workspace (`public/operator/`), gated by Cloudflare Access + Worker-side JWT verification

Host role is derived from the request hostname; any other host (including
`*.workers.dev`) gets a 404. Asset prefixes are enforced per role — operator
assets are never served on customer hosts.

Full system internals — request pipeline, data model, security model,
failure-mode contract, decision records: **`docs/ARCHITECTURE.md`**.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | `wrangler dev --env local`, local D1 only, `http://localhost:8787` |
| `npm run lint` / `npm run test` | ESLint + vitest unit tests |
| `npm run test:e2e` | Playwright against the local worker |
| `npm run deploy:dry-run` | build + lint + test, then `wrangler deploy --dry-run` |
| `npm run deploy` | build + lint + test, then production deploy |
| `npm run build:ui` | bundle `src/{booking,operator}/app.js` → minified `public/{booking,operator}/app.js` (auto-runs before dev/test/deploy) |

## Configuration inventory

**Vars** (in `wrangler.jsonc`, safe to commit):
`ENVIRONMENT`, `PUBLIC_BOOKING_ENABLED`, `PRICE_REVISION`, `BOOKING_LEAD_MINUTES`, `TURNSTILE_SITEKEY`,
`CUSTOMER_HOSTS`, `TURNSTILE_HOSTNAMES`, `OPERATOR_HOST`,
`OPERATOR_ALLOWED_EMAILS`, `SERVICE_TIMEZONE`.

`BOOKING_LEAD_MINUTES` (default 60) is the minimum notice before pickup for customer bookings and reschedules; the operator may schedule any slot that has not started.

**Optional vars:** `TERMS_POLICY_VERSION` (defaults to `launch-v1`) — bump it
with each legal-page revision so `terms_accepted_at`/`terms_policy_version`
records stay meaningful. `CUSTOMER_ORIGIN`, `OPERATOR_ORIGIN` extend CORS
origins if ever needed.

**Secrets** (set via `wrangler secret put`, never committed):

| Secret | Purpose |
|---|---|
| `TURNSTILE_SECRET` | Siteverify for public mutations. Absent in prod → mutations fail closed (403). |
| `TRACKING_TOKEN_ENCRYPTION_KEY` | base64url 32-byte AES-GCM key; encrypts stored tracking tokens for replay/share recovery. Absent → booking create fails closed (503). Local value goes in `.dev.vars` (see `.dev.vars.example`). |
| `ACCESS_TEAM_DOMAIN` | e.g. `https://<team>.cloudflareaccess.com` — Access issuer. |
| `ACCESS_AUD` | Access application AUD tag for `ops.lazylaundry.me`. |

Without `ACCESS_*` configured, operator endpoints return 503 "not configured" —
fail-closed by design. `OPERATOR_ALLOWED_EMAILS` is a var, not a secret.

## Operator access setup

1. Cloudflare Zero Trust → Access → application for `ops.lazylaundry.me`
   (self-hosted, OTP or IdP), policy allowing the operator email(s).
2. Copy the app's AUD tag → `ACCESS_AUD`; team domain → `ACCESS_TEAM_DOMAIN`.
3. Set `OPERATOR_ALLOWED_EMAILS` var to the allowed email(s).
4. Access rejects unauthenticated traffic at the edge; the Worker independently
   verifies the `Cf-Access-Jwt-Assertion` JWT (JWKS, cached 10 min per isolate)
   and checks the email allowlist — defense in depth, not redundant.
5. Local dev bypass: `ENVIRONMENT=local` + `X-Local-Operator-Email` header
   matching `LOCAL_OPERATOR_EMAIL`. Never accepted in production.

## Database

D1 `lazylaundry-db` (prod) / `lazy-laundry-local` (dev). Migrations in
`api/migrations/` are **additive and not undone by Worker rollback**.

```bash
wrangler d1 migrations apply lazylaundry-db            # production (after review)
wrangler d1 migrations apply lazy-laundry-local --local  # local
```

A Worker rollback restores code only — already-applied migrations stay. Review
migration ordering before deploying code that depends on a new one; deploy the
migration-compatible code first or apply migrations and deploy together.

Backups: D1 Time Travel / point-in-time restore is the recovery path. Before
launch, do one restore drill so the procedure is proven, not assumed.

## Deploy & rollback

`npm run deploy` runs build → lint → unit tests, then deploys. The e2e suite is
deliberately not in the deploy gate (needs local D1 + browsers) — run
`npm run test:e2e` before any *flagged* launch step and after UI-heavy changes.

Rollback: `wrangler rollback` (or redeploy a known-good commit). Safe for code;
unsafe to assume it unmigrates the database.

## Watch list

Structured `console.error` events worth alerting on / grepping in Logs:

`booking_create_failed`, `promo_redemption_guard_mismatch`,
`d1_health_check_failed`, `tracking_token_replay_unavailable`,
`availability_lookup_failed`, `estimate_failed`, `tracking_lookup_failed`,
`customer_booking_mutation_failed`, `operator_request_failed`.

## Standing decisions

- **Public intake is open (owner decision, 2026-10-19).** `PUBLIC_BOOKING_ENABLED`
  is committed as `"true"` so the repo matches production and a routine deploy
  can never silently close bookings; `tests/config.test.js` enforces this.
  It is the emergency stop: from a clean checkout of `main` run
  `npx wrangler deploy --var PUBLIC_BOOKING_ENABLED:false --message "emergency stop"`,
  then commit the flag change (and update the config test) so the next deploy
  does not reopen intake.
- **`/api/estimate` discloses outstanding penalty fees for a phone number**
  without identity proof. Accepted: the fee must be shown before the customer
  commits, the endpoint is Turnstile-gated and rate-limited, and phone numbers
  are already known to the people who'd ask. Revisit if enumeration abuse is
  observed.
- **Tracking-token key rotation.** `tracking_token_key_version` is stored
  (`'v1'`) but code reads a single key. Rotating breaks decryption of stored
  tokens (idempotent replays can't re-show the private link; tracking by hash
  still works). To rotate cleanly: keep old key under its version for decrypt,
  mint new for encrypt — implement before it's needed.
- **`workers_dev` stays enabled** — `hostRole` 404s it, so it serves nothing;
  kept for preview/dry-run convenience.
- **HSTS is `max-age=15552000; includeSubDomains`** — consider `preload` only
  after a deliberate submission decision; it's effectively permanent.
- **Readable UI source is never shipped.** JavaScript source lives in `src/`;
  `public/` receives only the two minified app bundles from `build:ui`.
  Client code is visible to anyone with DevTools regardless — the security
  boundary is the Worker (server-side pricing, hashed tokens, JWT auth), not
  hidden code. Bundling is for payload size and casual-readability, not
  secrecy. Host isolation is tested against the real shipped files
  (`/operator/app.js` must 404 on customer hosts and vice versa).
