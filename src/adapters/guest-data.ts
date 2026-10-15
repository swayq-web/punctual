/**
 * Guest personal-data purge (SwayQ ADR-0082; SWA-1290). Two entry points:
 *
 *  - `purgeExpiredGuestData`: the five-minute cron's retention sweep.
 *  - `eraseGuestByEmail`: the instance admin's erase-on-request action.
 *
 * What lives where is in docs/data-retention.md. Neither entry point ever
 * logs an email, a name or an answer: counts only.
 */

import type { Booking } from '../core/domain/types.js'
import {
  GUEST_DATA_RETENTION_MONTHS,
  RETENTION_BATCH,
  normaliseGuestEmail,
  retentionCutoff,
} from '../core/domain/guest-data.js'
import type { EnginePorts, Repositories } from '../ports.js'

const log = (event: string, counts: Record<string, number>) =>
  console.log(JSON.stringify({ source: 'punctual.guest_data', event, ...counts }))

/**
 * One bounded sweep per cron tick: bookings that ended more than
 * GUEST_DATA_RETENTION_MONTHS ago are anonymised in place, and expired
 * idempotency records and login tokens (which hold an email or the booking
 * response) are deleted. Idempotent, and it never throws: a failed step is
 * logged by name and the next tick tries again.
 */
export async function purgeExpiredGuestData(ports: EnginePorts, now: number): Promise<void> {
  const counts = { bookings: 0, idempotency: 0, magicLinks: 0 }
  // Resolved lazily inside each step so even a failure to build the
  // repositories is contained, named, and retried next tick.
  const guestData = () => ports.repositories({ consistency: 'bookmark' }).guestData
  const steps: Array<[keyof typeof counts, () => Promise<number>]> = [
    ['bookings', () => guestData().anonymiseEndedBefore(retentionCutoff(now), RETENTION_BATCH)],
    ['idempotency', () => guestData().pruneExpiredIdempotency(now, RETENTION_BATCH)],
    ['magicLinks', () => guestData().pruneExpiredMagicLinks(now, RETENTION_BATCH)],
  ]
  for (const [name, step] of steps) {
    try {
      counts[name] = await step()
    } catch {
      // Name only: the error text of a failed UPDATE can quote bound values.
      console.error(JSON.stringify({ source: 'punctual.guest_data', event: 'retention_step_failed', step: name }))
    }
  }
  if (counts.bookings + counts.idempotency + counts.magicLinks > 0) {
    log('retention_purged', { ...counts, retentionMonths: GUEST_DATA_RETENTION_MONTHS })
  }
}

export interface EraseResult {
  bookingsAnonymised: number
  bookingsCancelled: number
  idempotencyDeleted: number
  magicLinksDeleted: number
}

/**
 * Erase one guest, across every host, now.
 *
 * Order matters. Future confirmed bookings are cancelled FIRST through the
 * caller's normal cancel path (`cancel`), so the guest is told, the slot is
 * released and the Google event is deleted by the calendar sync; only then is
 * the personal data removed. If a cancel throws, nothing is anonymised and the
 * error propagates: the action can be repeated, and a half-erased guest with a
 * live calendar event is the one outcome this must not produce.
 *
 * Past events already written to a host's Google Calendar are outside this app
 * (docs/data-retention.md).
 */
export async function eraseGuestByEmail(
  deps: {
    repos: Repositories
    now: number
    actorUserId: string
    newId: () => string
    cancel: (booking: Booking) => Promise<boolean>
  },
  rawEmail: string,
): Promise<EraseResult> {
  const email = normaliseGuestEmail(rawEmail)
  let cancelled = 0
  for (const booking of await deps.repos.guestData.listUpcomingConfirmedForGuest(email, deps.now)) {
    if (await deps.cancel(booking)) cancelled += 1
  }
  const erased = await deps.repos.guestData.eraseByEmail(email)
  const result: EraseResult = {
    bookingsAnonymised: erased.bookings,
    bookingsCancelled: cancelled,
    idempotencyDeleted: erased.idempotency,
    magicLinksDeleted: erased.magicLinks,
  }
  await deps.repos.guestData.recordErasure({ id: deps.newId(), at: deps.now, actorUserId: deps.actorUserId, ...result })
  log('guest_erased', { ...result })
  return result
}
