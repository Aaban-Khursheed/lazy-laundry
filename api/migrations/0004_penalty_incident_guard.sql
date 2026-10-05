CREATE UNIQUE INDEX penalty_events_one_booking_incident
  ON penalty_events (source_booking_id, reason)
  WHERE source_booking_id IS NOT NULL
    AND reason IN ('late_cancellation', 'no_show');
