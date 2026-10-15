/**
 * Guest-side repeat bookings: the per-guest daily cap and the "this guest
 * already has a booking with you" note for the host.
 *
 * Pure helpers over what `BookingRepository.listForHost` already returns, so
 * nothing here needs a new query or a new column.
 */

import type { Booking } from './types.js'

/** At most this many booking attempts per guest email per host per day (enforced by the rate limiter in the confirm route). */
export const GUEST_EMAIL_DAILY_LIMIT = 3
export const GUEST_EMAIL_WINDOW_SECONDS = 24 * 60 * 60

/** The limiter key: one bucket per (host, normalised guest email). Case and surrounding space never buy a second bucket. */
export function guestLimitKey(hostUserId: string, guestEmail: string): string {
  return `${hostUserId}:${guestEmail.trim().toLowerCase()}`
}

/**
 * The start of the earliest OTHER confirmed upcoming booking this guest has
 * with this host, or null. `candidates` is the host's upcoming bookings (any
 * guest); `current` is the booking just made and is never its own duplicate.
 * A rescheduled-away predecessor is excluded by status.
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

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/

export type ColleaguesResult =
  | { ok: true; emails: string[] }
  | { ok: false; error: 'invalid'; email: string }
  | { ok: false; error: 'too_many' }

export const MAX_COLLEAGUES = 3

/**
 * Parse the "add colleagues" field: comma, semicolon or whitespace separated,
 * validated, lower-cased, de-duplicated, and never including the booker or
 * anyone already counted. More than three DISTINCT addresses is an error
 * rather than a silent truncation: the guest should know who was left off.
 */
export function parseColleagues(raw: string, guestEmail: string): ColleaguesResult {
  const guest = guestEmail.trim().toLowerCase()
  const seen = new Set<string>([guest])
  const emails: string[] = []
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase()
    if (email === '') continue
    if (email.length > 254 || !EMAIL_SHAPE.test(email)) return { ok: false, error: 'invalid', email: part.trim() }
    if (seen.has(email)) continue
    seen.add(email)
    emails.push(email)
  }
  if (emails.length > MAX_COLLEAGUES) return { ok: false, error: 'too_many' }
  return { ok: true, emails }
}

/** The declared-answer key the colleagues travel under until the domain model has real extra attendees. */
export const COLLEAGUES_ANSWER_KEY = 'colleagues'
