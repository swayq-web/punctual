/**
 * Calendar sync state: the pure half (no Cloudflare, no provider imports).
 *
 * The adapter half lives in adapters/calendar-sync-errors.ts (classifying a
 * provider error) and adapters/calendar-sync-alerts.ts (telling the host).
 */

import type { Booking, CalendarSyncErrorCategory } from './types.js'

/**
 * The guest-facing refusal on a drifted booking's manage link.
 *
 * i18n: this is the English text for key `bookingDrifted`. It is one exported
 * string so the integrator can swap it for a `t('bookingDrifted')` call in one
 * place. It deliberately names no internal detail: the guest is told what to
 * do, not what went wrong on the host's calendar.
 */
export const BOOKING_DRIFTED_MESSAGE =
  'This meeting was changed on the host’s calendar, so it can no longer be rescheduled or cancelled here. Please contact the host directly.'

/** True when the guest's manage link must refuse to reschedule or cancel. */
export function isDrifted(booking: Pick<Booking, 'calendarSyncStatus'>): boolean {
  return booking.calendarSyncStatus === 'drifted'
}

const RETRYABLE: ReadonlySet<CalendarSyncErrorCategory> = new Set(['rate_limited', 'provider_unavailable', 'network'])

export function isRetryableCategory(category: CalendarSyncErrorCategory): boolean {
  return RETRYABLE.has(category)
}

/**
 * Seconds before the next delivery, by attempt (1-based). Exponential from
 * 10 s, capped at 10 min: a 429 is answered by backing off, not by hammering,
 * and the cap keeps the sixth and last delivery inside the hour.
 */
export function retryDelaySeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(600, 10 * 3 ** (n - 1))
}

/**
 * How many deliveries a create may hold the guest's confirmation for while a
 * retryable calendar error is being retried, so the email can still carry the
 * meeting link. After that the confirmation goes out without one: a calendar
 * outage must never become an email outage. With the delays above this holds
 * the email for about 10 seconds at most.
 */
export const HOLD_CONFIRMATION_DELIVERIES = 1

/** One plain sentence per category, for the host's alert email. No provider detail. */
export function describeSyncError(category: CalendarSyncErrorCategory | null | undefined): string {
  switch (category) {
    case 'needs_reconnect':
      return 'Your calendar connection has expired or was revoked. Reconnect it in Settings.'
    case 'setup_required':
      return 'The calendar API is not enabled for this deployment. Ask your administrator to enable it.'
    case 'permission_denied':
      return 'The connected account is not allowed to write to the chosen calendar.'
    case 'not_found':
      return 'The chosen calendar no longer exists.'
    case 'rejected':
      return 'The calendar provider rejected the event.'
    case 'rate_limited':
      return 'The calendar provider kept asking us to slow down.'
    case 'provider_unavailable':
      return 'The calendar provider was unavailable.'
    case 'network':
      return 'The calendar provider could not be reached.'
    case 'retries_exhausted':
    default:
      return 'The calendar write kept failing and was given up on.'
  }
}
