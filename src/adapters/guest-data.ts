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
  /**
   * Upcoming confirmed bookings for this guest that are STILL confirmed after
   * the cancel passes (a cancel lost a race, or one was made meanwhile). They
   * are not anonymised; the admin should repeat the action.
   */
  stillUpcoming: number
}

/** Which half failed. Either way nothing was erased by the failing step. */
export class EraseError extends Error {
  constructor(readonly stage: 'cancel' | 'erase') {
    super(stage === 'cancel' ? 'cancelling an upcoming meeting failed' : 'the erase batch failed and was rolled back')
  }
}

/**
 * Erase one guest, across every host, now.
 *
 * Order matters. Upcoming confirmed bookings are cancelled FIRST through the
 * caller's normal cancel path (`cancel`): the slot is released, the guest is
 * told and the calendar sync deletes the Google event. Two passes, so a
 * booking made while the first was running is caught too. Then ONE atomic
 * batch anonymises and deletes and writes the audit line; it never touches an
 * upcoming confirmed booking, so a cancel that lost a race leaves that
 * booking whole and visible in `stillUpcoming` instead of orphaning its
 * Google event with the guest erased.
 *
 * Past events already in a host's Google Calendar are outside this app
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
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (const booking of await deps.repos.guestData.listUpcomingConfirmedForGuest(email, deps.now)) {
        if (await deps.cancel(booking)) cancelled += 1
      }
    }
  } catch {
    throw new EraseError('cancel')
  }
  let erased
  try {
    erased = await deps.repos.guestData.eraseByEmail(
      email,
      { id: deps.newId(), at: deps.now, actorUserId: deps.actorUserId, bookingsCancelled: cancelled },
      deps.now,
    )
  } catch {
    throw new EraseError('erase')
  }
  const stillUpcoming = (await deps.repos.guestData.listUpcomingConfirmedForGuest(email, deps.now)).length
  const result: EraseResult = {
    bookingsAnonymised: erased.bookings,
    bookingsCancelled: cancelled,
    idempotencyDeleted: erased.idempotency,
    magicLinksDeleted: erased.magicLinks,
    stillUpcoming,
  }
  log('guest_erased', { ...result })
  return result
}
