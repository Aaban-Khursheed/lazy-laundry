PRAGMA foreign_keys = ON;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY NOT NULL,
  booking_number TEXT NOT NULL UNIQUE,
  tracking_token_hash TEXT NOT NULL UNIQUE,
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
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'qr')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  status TEXT NOT NULL DEFAULT 'booking_received' CHECK (status IN ('booking_received', 'confirmed', 'pickup_on_the_way', 'laundry_picked_up', 'processing', 'ready', 'delivered', 'cancelled')),
  ready_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX bookings_one_active_per_pickup_slot
  ON bookings (pickup_date, pickup_slot)
  WHERE status <> 'cancelled';

CREATE INDEX bookings_status_pickup_idx
  ON bookings (status, pickup_date, pickup_slot);

CREATE TABLE booking_events (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('status', 'payment')),
  from_value TEXT,
  to_value TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX booking_events_booking_created_idx
  ON booking_events (booking_id, created_at);
