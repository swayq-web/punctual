-- Audit line for an instance admin's "erase this guest" action (SwayQ ADR-0082,
-- SWA-1290). Forward-only and additive (ADR-0006 §4).
--
-- COUNTS ONLY. The erased email is deliberately NOT stored, not even hashed:
-- a hash of an email is a pseudonymous identifier that anyone holding the
-- email can re-derive, which would defeat the erasure it documents.
-- Who erased, when, and how many rows of each kind is the whole record.
CREATE TABLE IF NOT EXISTS guest_erasure_log (
  id                   TEXT PRIMARY KEY,
  at                   INTEGER NOT NULL,
  actor_user_id        TEXT NOT NULL,
  bookings_anonymised  INTEGER NOT NULL,
  bookings_cancelled   INTEGER NOT NULL,
  idempotency_deleted  INTEGER NOT NULL,
  magic_links_deleted  INTEGER NOT NULL
);
