/**
 * Guest personal-data retention (SwayQ ADR-0082; SWA-1290). Pure: no I/O.
 *
 * The promise: a guest's name, email and free-text answers are kept for
 * GUEST_DATA_RETENTION_MONTHS after the meeting ends, then anonymised. The
 * booking row itself stays (ids, times, host, status) so the host's history
 * and the stats stay coherent; only the person is removed from it.
 */

/** The one place the retention period is defined. */
export const GUEST_DATA_RETENTION_MONTHS = 12

/** Bookings anonymised per cron tick, at most. Bounds the tick's D1 writes. */
export const RETENTION_BATCH = 100

/**
 * What an anonymised booking carries instead of the guest. Fixed values, so
 * "already anonymised" is a plain equality test and a second run changes
 * nothing. `.invalid` is reserved (RFC 2606): it can never route to anyone.
 */
export const TOMBSTONE = {
  guestName: 'Erased guest',
  guestEmail: 'erased@erased.invalid',
  guestTimezone: 'UTC',
  guestLocale: null,
  answersJson: '{}',
} as const

/**
 * Bookings whose end is strictly before this instant are past retention.
 * Calendar months in UTC, not 365-day multiples: "12 months" means the same
 * date a year ago, leap years included. Clamped so 31 March minus one month
 * is the end of February rather than 3 March.
 */
export function retentionCutoff(now: number, months: number = GUEST_DATA_RETENTION_MONTHS): number {
  const d = new Date(now)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d.getTime()
}

/** Guest emails are stored lower-cased (booking-service); compare the same way. */
export function normaliseGuestEmail(email: string): string {
  return email.trim().toLowerCase()
}
