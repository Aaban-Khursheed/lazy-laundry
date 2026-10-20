# Lazy Laundry — Operations Runbook

Single Worker (`api/worker.js`), D1 `lazylaundry-db`, static apps under
`public/`. Timezone `Asia/Kuala_Lumpur`. Cash/QR at pickup — no payment
gateway exists.

## Daily operation

- **Queue**: `ops.lazylaundry.me` → dashboard shows active bookings. Lifecycle
  buttons advance `confirmed → pickup_on_the_way → laundry_picked_up →
  processing → ready → delivered`. Payment toggle is per-booking.
- **Capacity**: Capacity tab → block a whole date or one slot. Blocks hide
  inventory from customers instantly but **never cancel existing bookings** —
  the `affected bookings` count shows what still needs hands-on handling.
  Removing a block needs the current revision (the UI sends it); other blocks
  or existing bookings may still make the slot unavailable.
- **Fees**: outstanding `penalty_events` auto-allocate onto the customer's
  next booking as `fee_total_cents`. Waive/settle from the booking detail.
- **Promos**: operator-managed codes; percent 1–90%, fixed RM1–RM500, optional
  min-spend + max redemptions. Discounts apply to service total only.

## Alerts and reminders

- Every customer-side change emails `OPERATOR_ALERT_EMAIL` via the `EMAIL`
  binding (pinned destination — the Worker cannot send elsewhere).
- `*/15` cron digests `confirmed` pickups starting within 90 minutes.
- Alert failure is logged as `operator_alert_failed` and never blocks a
  booking. If sends stop: check Email Sending onboarding + destination
  verification (README → Operator alerts).

## Rate limits & abuse controls

- `RATE_LIMITER` 100/min per IP (general), `RATE_LIMITER_BOOKING` 5/min per
  IP (create), `ACTIVE_BOOKING_LIMIT` 2 active bookings per phone.
- 429 responses are expected abuse-control behavior, not an outage.
- Local dev binds identical in-memory limiters.

## Emergency stop

`PUBLIC_BOOKING_ENABLED` in `wrangler.jsonc` is the intake kill switch —
set `"false"` and deploy. Customer tracking/cancellation stay live.
Only change it on the owner's instruction.

## Deploy & rollback

```bash
npm run db:check                                      # 1. review pending migrations
wrangler d1 migrations apply lazylaundry-db --remote  # 2. ALWAYS --remote, BEFORE deploy
npm run deploy:dry-run                                # 3. gate: lint + unit + bundle
npm run deploy                                        # 4. production deploy
wrangler rollback                                     # 5. restore previous Worker code
```

**Order matters:** code that queries a not-yet-migrated column/table serves
503s until the migration lands. Remote-apply first, deploy second — learned
the hard way (2026-10-21: availability 503 for ~7 min because `0010` was
missing remotely while the deployed code referenced `removed_at`).

Rollback restores **code only** — applied migrations stay. Deploy
migration-compatible code first, or apply the migration and deploy together.

## Migrations

- Append `api/migrations/NNNN_name.sql`; never edit an applied file.
- `npm run db:check` must pass (ordering + destructive-statement review).
- Production apply: `wrangler d1 migrations apply lazylaundry-db` after review.
- Local: `wrangler d1 migrations apply lazy-laundry-local --local --env local`.

## Backup / restore

- D1 Time Travel is the recovery path. Drill procedure before launch and
  after any destructive-rebuild migration:
  `wrangler d1 time-travel restore lazylaundry-db --timestamp <RFC3339>`.
- Verify restores against a scratch query, not just exit code.

## Scheduled jobs

- `*/15 * * * *` (the only cron) runs both:
  - pickup reminders (above);
  - retention anonymization in small batches — PII scrubbed 24 months after
    a booking's terminal state; outstanding fee records are kept until
    settled (PDPA). A backlog drains across consecutive runs.

## Incidents worth paging the owner for

- `d1_health_check_failed` in logs → `/api/health` 503.
- `operator_alert_failed` repeating → email pipeline down.
- Spike of `slot_unavailable` 409s without operator blocks → possible abuse.
- Bookings stuck >24h in one status → see T17 data hygiene ticket.
