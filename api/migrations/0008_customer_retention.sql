-- Scheduled retention pass markers. customer_anonymized_at is set when a
-- terminal booking's identity fields are scrubbed; customers.anonymized_at is
-- set on the replacement anon- customer row once none of a customer's
-- bookings remain identifiable.
ALTER TABLE bookings ADD COLUMN customer_anonymized_at TEXT;
ALTER TABLE customers ADD COLUMN anonymized_at TEXT;

CREATE INDEX bookings_retention_idx
  ON bookings (status, updated_at)
  WHERE customer_anonymized_at IS NULL;
