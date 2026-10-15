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

-- The retention sweep ("ended before the cutoff, not yet anonymised") reads
-- only rows that still hold a guest: a partial index on end_utc excluding the
-- tombstone, so anonymised rows leave it and the sweep stops re-scanning them.
-- The query spells the tombstone address as a literal, which is what lets
-- SQLite prove it matches this index.
CREATE INDEX IF NOT EXISTS bookings_retention_idx ON bookings (end_utc)
  WHERE guest_email <> 'erased@erased.invalid';
