-- Operator-managed capacity blocks. A row with pickup_slot NULL blocks the
-- whole date; a row with a slot blocks that pickup time only. Blocks apply to
-- customer booking/reschedule (availability hides them and the guarded
-- booking insert rejects them); the operator may still schedule over a block.
CREATE TABLE blocked_slots (
  id TEXT PRIMARY KEY NOT NULL,
  pickup_date TEXT NOT NULL,
  pickup_slot TEXT CHECK (pickup_slot IS NULL OR pickup_slot GLOB '[0-9][0-9]:[0-9][0-9]'),
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX blocked_slots_whole_date_idx
  ON blocked_slots (pickup_date) WHERE pickup_slot IS NULL;
CREATE UNIQUE INDEX blocked_slots_date_slot_idx
  ON blocked_slots (pickup_date, pickup_slot) WHERE pickup_slot IS NOT NULL;
