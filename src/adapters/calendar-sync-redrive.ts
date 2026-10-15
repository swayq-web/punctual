/**
 * Re-drive a host's calendar syncs once their calendar is usable again
 * (SWA-1286).
 *
 * A booking whose host's only write-capable connection was broken is
 * recorded `failed` with `needs_reconnect` (adapters/queue/consumer.ts),
 * never `synced`. When that host reconnects (http/calendar-connect.ts), their
 * upcoming bookings in that state are reopened (`failed` -> `pending`, so a
 * fresh failure alerts again) and their create sync is enqueued again.
 *
 * The create path is idempotent: connections that already hold an event id
 * are skipped, Google's event id is stable, and the guest's confirmation was
 * claimed on the first pass, so nothing is sent twice.
 */

import type { EnginePorts } from '../ports.js'
import { logSync } from './calendar-sync-errors.js'

/** Upcoming bookings re-driven per reconnect, at most. */
export const REDRIVE_LIMIT = 100

export async function redriveAfterReconnect(ports: EnginePorts, hostUserId: string): Promise<number> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const now = ports.clock.now()
  let redriven = 0
  for (const booking of await repos.bookings.listFailedNeedingReconnect(hostUserId, now, REDRIVE_LIMIT)) {
    // Conditional: two reconnects racing re-drive each booking once.
    if (!(await repos.bookings.reopenCalendarSync(booking.id, now))) continue
    try {
      await ports.queue.send({ kind: 'calendar.sync', bookingId: booking.id, action: 'create' })
      redriven += 1
      logSync('info', { event: 'redriven_after_reconnect', bookingId: booking.id, stage: 'reconcile' })
    } catch {
      // Left `pending`; with no event ids the 5-minute reconciler picks it up.
      logSync('warn', { event: 'redrive_failed', bookingId: booking.id, stage: 'reconcile' })
    }
  }
  return redriven
}
