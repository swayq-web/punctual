/**
 * Guest-side repeat bookings: the per-guest daily cap and the "this guest
 * already has a booking with you" note for the host.
 *
 * Pure helpers over what `BookingRepository.listForHost` already returns, so
 * nothing here needs a new query or a new column.
 */

import type { Booking } from './types.js'

/** At most this many bookings per guest email per host per rolling day. */
export const GUEST_EMAIL_DAILY_LIMIT = 3
export const GUEST_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * One address, one identity: case, surrounding space and a `+tag` in the local
 * part never buy a second allowance (`Anna+1@x.dk` is `anna@x.dk`).
 */
export function normalizeGuestEmail(email: string): string {
  const e = email.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  const local = e.slice(0, at)
  const plus = local.indexOf('+')
  return `${plus > 0 ? local.slice(0, plus) : local}${e.slice(at)}`
}

/**
 * Bookings this guest MADE with this host in the last day (by creation time,
 * not start time). Confirmed bookings only, because that is what the host's
 * list holds, and a replacement created by a reschedule is not a new booking.
 * Counted from the bookings that actually exist, so an attempt that failed
 * (slot taken, calendar down) never uses up the guest's allowance.
 */
export function countRecentGuestBookings(
  candidates: readonly Booking[],
  guestEmail: string,
  now: number,
  windowMs: number = GUEST_EMAIL_WINDOW_MS,
): number {
  const email = normalizeGuestEmail(guestEmail)
  const seen = new Set<string>()
  for (const b of candidates) {
    if (seen.has(b.id)) continue
    if (b.status !== 'confirmed' || b.rescheduleOf) continue
    if (b.createdAt < now - windowMs) continue
    if (normalizeGuestEmail(b.guestEmail) !== email) continue
    seen.add(b.id)
  }
  return seen.size
}

/**
 * The start of the earliest OTHER confirmed upcoming booking this guest has
 * with this host, or null. `candidates` is the host's upcoming bookings (any
 * guest); `current` is the booking just made and is never its own duplicate.
 */
export function findOtherUpcomingGuestBooking(
  candidates: readonly Booking[],
  current: Pick<Booking, 'id' | 'guestEmail'>,
  now: number,
): number | null {
  const email = current.guestEmail.trim().toLowerCase()
  let earliest: number | null = null
  for (const b of candidates) {
    if (b.id === current.id) continue
    if (b.status !== 'confirmed') continue
    if (b.startUtc <= now) continue
    if (b.guestEmail.trim().toLowerCase() !== email) continue
    if (earliest === null || b.startUtc < earliest) earliest = b.startUtc
  }
  return earliest
}
