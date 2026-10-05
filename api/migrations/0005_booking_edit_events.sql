PRAGMA foreign_keys = OFF;

ALTER TABLE booking_events RENAME TO booking_events_old;

CREATE TABLE booking_events (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('status', 'payment', 'edit')),
  from_value TEXT,
  to_value TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
SELECT id, booking_id, event_type, from_value, to_value, actor_id, created_at
FROM booking_events_old;

DROP TABLE booking_events_old;

CREATE INDEX booking_events_booking_created_idx ON booking_events (booking_id, created_at);

PRAGMA foreign_keys = ON;
