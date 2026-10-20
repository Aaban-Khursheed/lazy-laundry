ALTER TABLE blocked_slots ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE blocked_slots ADD COLUMN removed_at TEXT;
ALTER TABLE blocked_slots ADD COLUMN removed_by TEXT;

DROP INDEX blocked_slots_whole_date_idx;
DROP INDEX blocked_slots_date_slot_idx;

CREATE UNIQUE INDEX blocked_slots_whole_date_idx
  ON blocked_slots (pickup_date)
  WHERE pickup_slot IS NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX blocked_slots_date_slot_idx
  ON blocked_slots (pickup_date, pickup_slot)
  WHERE pickup_slot IS NOT NULL AND removed_at IS NULL;

CREATE TABLE capacity_events (
  id TEXT PRIMARY KEY NOT NULL,
  block_id TEXT NOT NULL REFERENCES blocked_slots (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'removed')),
  actor_id TEXT,
  reason TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL
);

CREATE INDEX capacity_events_block_created_idx ON capacity_events (block_id, created_at);

INSERT INTO capacity_events (id, block_id, event_type, actor_id, reason, revision, created_at)
  SELECT 'created-' || id, id, 'created', created_by, reason, revision, created_at FROM blocked_slots;
