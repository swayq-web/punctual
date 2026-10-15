-- Durable calendar sync: what happened to each booking's calendar events,
-- and the guest's language.
--
-- Forward-only and additive (ADR-0006 §4). Every column is defaulted or
-- nullable, so code from before this migration keeps working against the new
-- schema, and rolling the Worker back needs no schema change.
--
-- Until now a calendar write that failed was logged and the queue message
-- acked: the booking read "confirmed", no event existed on anyone's calendar,
-- nothing retried and nobody was told. These columns are what the queue
-- consumer, the dead-letter consumer and the */5 reconciler
-- (adapters/scheduled.ts) read and write so that never happens silently.

-- 'pending'  the create (or a retry of it) has not landed yet
-- 'synced'   every planned event exists, or there was nothing to write
-- 'failed'   a permanent error, or retries ran out; the host was told
-- 'drifted'  the event was moved or deleted on the calendar itself; the host
--            was told, and the guest's manage link refuses to act on it
ALTER TABLE bookings ADD COLUMN calendar_sync_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (calendar_sync_status IN ('pending', 'synced', 'failed', 'drifted'));

-- Failed attempts so far, across queue redeliveries and reconciler re-enqueues.
ALTER TABLE bookings ADD COLUMN calendar_sync_attempts INTEGER NOT NULL DEFAULT 0;

-- An error CATEGORY ('rate_limited', 'needs_reconnect', ...), never a raw
-- provider body: those can echo attendee addresses back.
ALTER TABLE bookings ADD COLUMN calendar_sync_error TEXT;

-- When the events were last known to match the booking: set on a successful
-- write and on every drift check that finds them unchanged, so the drift
-- check works through the oldest-verified bookings first.
ALTER TABLE bookings ADD COLUMN calendar_synced_at INTEGER;

-- The guest's language for their emails and pages (e.g. 'en', 'da'). NULL
-- means "not recorded", which every reader treats as the deployment default.
-- Written by the booking flow; this migration only makes room for it.
ALTER TABLE bookings ADD COLUMN guest_locale TEXT;

-- Backfill.
--
-- A booking with stored event ids got its events: synced, as of when it was
-- made (the closest honest timestamp we have).
UPDATE bookings
   SET calendar_sync_status = 'synced', calendar_synced_at = created_at
 WHERE external_event_ids_json != '{}';

-- A booking with no ids that is over, cancelled or rescheduled has nothing
-- left to write. Calling it pending would only make the reconciler look at it.
UPDATE bookings
   SET calendar_sync_status = 'synced'
 WHERE external_event_ids_json = '{}'
   AND (status != 'confirmed' OR start_utc <= CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- What is left is pending ON PURPOSE: a confirmed, upcoming booking with no
-- event ids is either one whose host has no writable calendar (the first
-- reconciler pass finds nothing to write and marks it synced) or one whose
-- sync failed silently under the old code (the reconciler re-runs it; event
-- ids are stable, so nothing is created twice, and 0009's backfill means no
-- second confirmation goes out).

-- The reconciler's two sweeps: pending upcoming bookings, and synced upcoming
-- bookings to check for drift.
CREATE INDEX IF NOT EXISTS bookings_calendar_sync_idx ON bookings (calendar_sync_status, start_utc);
