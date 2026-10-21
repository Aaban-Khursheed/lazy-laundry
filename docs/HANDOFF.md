# Lazy Laundry — Maintainer Handoff

Recorded 2026-10-21. Role-based record: names stay out of source; "the
original author" and "the incoming maintainer" are the roles used below.
Complements `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, and
`docs/OPERATIONS.md`; those remain authoritative for their subjects.

## What changed hands

- Day-to-day maintenance of this repository moved from the original
  author to the incoming maintainer on 2026-10-21.
- The canonical repository **remains `Aaban-Khursheed/lazy-laundry`** on
  GitHub — no transfer of ownership. The incoming maintainer works via
  collaborator access.
- Remote stays `git@github.com-aaban:Aaban-Khursheed/lazy-laundry.git`
  through the `lazy-laundry-deploy` SSH key (machine-global config; do
  not rewrite it to plain `github.com` — that breaks key selection).
- This repo's local `user.name`/`user.email` still reflects the original
  author. Confirm the intended identity with the owner before the first
  commit under a different name.
- Working branch: `v1.0` (checked out); `main` exists on the remote.
  CI release gates (`.github/workflows/ci.yml`) run on pushes to `v1.0`
  and `main` and on every pull request.

## Access the incoming maintainer needs (owner grants, outside git)

- **Cloudflare account**: the `lazylaundry` Worker, D1 `lazylaundry-db`,
  the two rate limiters, the `send_email` binding, and the three custom
  domains.
- **Cloudflare Zero Trust**: the Access application and policy for
  `ops.lazylaundry.me` (team domain + AUD tag) and the
  `OPERATOR_ALLOWED_EMAILS` var.
- **Wrangler secrets** — verify presence with `wrangler secret list`
  (values never enter the repo or chat): `TURNSTILE_SECRET`,
  `TRACKING_TOKEN_ENCRYPTION_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`.
- **Turnstile admin** for sitekey/secret rotation, and **Email Sending**
  onboarding for `lazylaundry.me` (SPF/DKIM auto-added; destination
  verification under Email Routing).
- **The operator mailbox** pinned in `send_email.destination_address` —
  who actually monitors `OPERATOR_ALERT_EMAIL` day to day.
- **GitHub collaborator invite** on `Aaban-Khursheed/lazy-laundry`.

## Standing orders (unchanged by the handoff)

- `AGENTS.md` is the contract. The launch baseline is **per-release**,
  not one-time — every item applies to every change.
- Owner decisions required before touching: `PUBLIC_BOOKING_ENABLED`,
  the 6-hour express promise, the 24-month retention mechanism, pricing,
  legal pages / `TERMS_POLICY_VERSION`, auth/CSP/security boundaries,
  SSH remotes, and git identities.
- Deploy order is strict: `wrangler d1 migrations apply lazylaundry-db
  --remote` **first**, `npm run deploy` second. `wrangler rollback`
  restores code only — never the database.
- Validation before any ship: `lint`, `test`, `test:e2e` (UI-heavy
  changes), `db:check` (any migration), `deploy:dry-run`.
- Honest reporting: PASS / FAIL / NOT ESTABLISHED. CI evidence records
  `production_acceptance=NOT_ESTABLISHED` until physical-device and real
  Access/Turnstile checks are done by hand.

## Read-first order

`README.md` → `docs/ARCHITECTURE.md` → `AGENTS.md` →
`docs/OPERATIONS.md` → `api/worker.js` (the entire backend, one file).

## Open items inherited

- **Gate 1 leftovers**: physical mobile-browser acceptance, and one D1
  Time Travel restore drill (`wrangler d1 time-travel restore
  lazylaundry-db --timestamp <RFC3339>`) so recovery is proven.
- **Tracking-token key rotation** is designed (`tracking_token_key_version`)
  but not implemented — build it before rotation is ever needed.
- **HSTS `preload`** remains a deferred deliberate decision.
- **Coverage gaps worth automating** (mapped 2026-10-21 against the
  baseline): ≥16px input-font / ≥44px tap-target assertions, a
  reduced-motion emulation check, operator tracking-link clearing on
  order switch/close, and drawer disclosures + the 1280×800 scroll-free
  check.
- Cosmetic: `tests/operator-alerts.test.js` names a "12 months" window;
  the enforced retention window is 24 months (`RETENTION_MS`, 730 days).
  Rename the test when it is next touched.
