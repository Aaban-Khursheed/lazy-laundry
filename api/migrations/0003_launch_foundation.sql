PRAGMA foreign_keys = OFF;

CREATE TABLE customers (
  id TEXT PRIMARY KEY NOT NULL,
  phone_e164 TEXT NOT NULL UNIQUE CHECK (length(phone_e164) BETWEEN 7 AND 16),
  penalty_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (penalty_balance_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO customers (id, phone_e164, created_at, updated_at)
SELECT
  'customer-' || replace(phone, '+', ''),
  phone,
  min(created_at),
  max(updated_at)
FROM bookings
GROUP BY phone;

CREATE TABLE bookings_next (
  id TEXT PRIMARY KEY NOT NULL,
  booking_number TEXT NOT NULL UNIQUE,
  tracking_token_hash TEXT NOT NULL UNIQUE,
  encrypted_tracking_token TEXT,
  tracking_token_key_version TEXT,
  idempotency_key_hash TEXT UNIQUE,
  request_payload_hash TEXT,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  phone TEXT NOT NULL CHECK (length(phone) BETWEEN 7 AND 20),
  block TEXT NOT NULL CHECK (length(block) BETWEEN 1 AND 80),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 40),
  package_size INTEGER NOT NULL CHECK (package_size IN (10, 18)),
  service TEXT NOT NULL CHECK (service IN ('standard', 'express')),
  folding INTEGER NOT NULL DEFAULT 1 CHECK (folding IN (0, 1)),
  ironing INTEGER NOT NULL DEFAULT 1 CHECK (ironing IN (0, 1)),
  hangers INTEGER NOT NULL DEFAULT 0 CHECK (hangers IN (0, 1)),
  pickup_date TEXT NOT NULL,
  pickup_slot TEXT NOT NULL,
  service_total_cents INTEGER NOT NULL CHECK (service_total_cents >= 0),
  fee_total_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_total_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'qr')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pickup_on_the_way', 'laundry_picked_up', 'processing', 'ready', 'delivered', 'cancelled')),
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('customer', 'customer_late', 'operator', 'no_show', 'other')),
  cancellation_actor TEXT,
  cancelled_at TEXT,
  ready_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  terms_accepted INTEGER NOT NULL DEFAULT 0 CHECK (terms_accepted IN (0, 1)),
  terms_accepted_at TEXT,
  terms_policy_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO bookings_next (
  id, booking_number, tracking_token_hash, customer_id, customer_name, phone, block, unit,
  package_size, service, folding, ironing, hangers, pickup_date, pickup_slot,
  service_total_cents, fee_total_cents, total_cents, payment_method, payment_status,
  status, ready_at, terms_accepted, created_at, updated_at
)
SELECT
  bookings.id,
  bookings.booking_number,
  bookings.tracking_token_hash,
  customers.id,
  bookings.customer_name,
  bookings.phone,
  bookings.block,
  bookings.unit,
  bookings.package_size,
  bookings.service,
  bookings.folding,
  bookings.ironing,
  bookings.hangers,
  bookings.pickup_date,
  bookings.pickup_slot,
  bookings.total_cents,
  0,
  bookings.total_cents,
  bookings.payment_method,
  bookings.payment_status,
  CASE WHEN bookings.status = 'booking_received' THEN 'confirmed' ELSE bookings.status END,
  bookings.ready_at,
  bookings.terms_accepted,
  bookings.created_at,
  bookings.updated_at
FROM bookings
JOIN customers ON customers.phone_e164 = bookings.phone;

ALTER TABLE booking_events RENAME TO booking_events_old;
DROP TABLE bookings;
ALTER TABLE bookings_next RENAME TO bookings;

CREATE TABLE booking_events (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('status', 'payment')),
  from_value TEXT,
  to_value TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
SELECT id, booking_id, event_type, from_value,
  CASE WHEN to_value = 'booking_received' THEN 'confirmed' ELSE to_value END,
  actor_id, created_at
FROM booking_events_old;

DROP TABLE booking_events_old;

CREATE TABLE penalty_events (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  source_booking_id TEXT REFERENCES bookings (id),
  allocated_booking_id TEXT REFERENCES bookings (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL CHECK (reason IN ('late_cancellation', 'no_show', 'other')),
  state TEXT NOT NULL DEFAULT 'outstanding' CHECK (state IN ('outstanding', 'allocated', 'settled', 'waived')),
  actor_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE booking_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT REFERENCES bookings (id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers (id),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 60),
  from_value TEXT,
  to_value TEXT,
  details_json TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE operator_notes (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX bookings_customer_idx ON bookings (customer_id, created_at);
CREATE INDEX bookings_status_pickup_idx ON bookings (status, pickup_date, pickup_slot);
CREATE INDEX bookings_phone_idx ON bookings (phone);
CREATE UNIQUE INDEX bookings_one_active_per_pickup_slot
  ON bookings (pickup_date, pickup_slot)
  WHERE status <> 'cancelled';
CREATE INDEX booking_events_booking_created_idx ON booking_events (booking_id, created_at);
CREATE INDEX penalty_events_customer_state_idx ON penalty_events (customer_id, state, created_at);
CREATE INDEX penalty_events_booking_idx ON penalty_events (allocated_booking_id, source_booking_id);
CREATE INDEX booking_audit_booking_created_idx ON booking_audit_events (booking_id, created_at);
CREATE INDEX operator_notes_booking_created_idx ON operator_notes (booking_id, created_at);

PRAGMA foreign_keys = ON;
