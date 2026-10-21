-- Operator alerts: remember when a booking last appeared in the pre-pickup
-- reminder digest so each booking surfaces to the operator exactly once.

ALTER TABLE bookings ADD COLUMN operator_reminded_at TEXT;
