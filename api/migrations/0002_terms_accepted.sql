ALTER TABLE bookings
  ADD COLUMN terms_accepted INTEGER NOT NULL DEFAULT 0 CHECK (terms_accepted IN (0, 1));
