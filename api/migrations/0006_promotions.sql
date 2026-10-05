-- Promotions: operator-managed discount codes applied to the service total
-- only. Bookings record the applied code and the granted discount in sen.

ALTER TABLE bookings ADD COLUMN promo_code TEXT;
ALTER TABLE bookings ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE promotions (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_service_cents INTEGER NOT NULL DEFAULT 0,
  max_redemptions INTEGER,
  redemptions INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_by TEXT,
  updated_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE promotion_events (
  id TEXT PRIMARY KEY NOT NULL,
  promotion_id TEXT NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated')),
  actor_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX bookings_promo_code_idx ON bookings (promo_code);
CREATE INDEX promotion_events_promotion_created_idx ON promotion_events (promotion_id, created_at);
