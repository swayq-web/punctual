/**
 * Cron work: reminders, hold expiry, lock pruning, digests, the calendar
 * sync reconciler, telemetry.
 *
 * Runs every 5 minutes. Each task is independent and failure-isolated —
 * a telemetry ping that cannot reach the internet must not stop reminders
 * going out.
 */

import type { EnginePorts } from '../ports.js'
import type { Booking, EventType, User } from '../core/domain/types.js'
import { classifyCalendarError, isCalendarSyncRetry, logSync } from './calendar-sync-errors.js'
import { alertCalendarSync } from './calendar-sync-alerts.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export async function runScheduledTasks(ports: EnginePorts, now: number): Promise<void> {
  const tasks: Array<[string, Promise<unknown>]> = [
    ['expire-holds', expireHolds(ports, now)],
    ['prune-locks', pruneLocks(ports, now)],
    ['reminders', sendReminders(ports, now)],
    ['digests', sendDigests(ports, now)],
    ['calendar-reconcile', reconcileCalendarSync(ports, now)],
  ]
  if (ports.config.telemetryEnabled) tasks.push(['telemetry', sendTelemetry(ports, now)])

  for (const [name, task] of tasks) {
    try {
      await task
    } catch (err) {
      console.error(`[punctual] scheduled task ${name} failed`, err)
    }
  }
}

/**
 * Sweep expired holds.
 *
 * Belt and braces: holds are already filtered on read by `expires_at > now`,
 * and each DO clears its own via alarm. This catches rows whose DO alarm was
 * lost, so the table cannot grow without bound.
 */
async function expireHolds(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  await repos.slotLocks.expireHolds(now)
}

/**
 * Prune slot_locks for past bookings.
 *
 * A 7-day trailing window is kept deliberately: locks are the record of what
 * occupied a calendar, and having a week of history makes "why was I not
 * offered that slot?" answerable.
 */
async function pruneLocks(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  await repos.slotLocks.pruneLocksBefore(now - 7 * DAY)
}

/**
 * Reminders at 24 h and 1 h before the meeting.
 *
 * The window is the cron interval, so a booking is picked up exactly once:
 * we look for meetings starting within [target, target + 5 min). Widening it
 * would double-send; narrowing it would drop reminders on a slow tick.
 */
async function sendReminders(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const windows: Array<{ label: '24h' | '1h'; from: number; to: number }> = [
    { label: '24h', from: now + DAY, to: now + DAY + 5 * MINUTE },
    { label: '1h', from: now + HOUR, to: now + HOUR + 5 * MINUTE },
  ]

  const { bookingReminder } = await import('../core/email-templates.js')

  for (const w of windows) {
    // Reminders are a cross-host query, which is exactly why bookings live in
    // D1 rather than in per-host DO storage (ADR-0002).
    const due = await repos.bookings.dueBetween(w.from, w.to)
    for (const booking of due) {
      const [eventType, host] = await Promise.all([
        repos.eventTypes.byId(booking.eventTypeId),
        repos.users.byId(booking.hostUserId),
      ])
      if (!eventType || !host) continue

      // Rendered for the GUEST, so times appear in the guest's timezone.
      const mail = bookingReminder({
        booking,
        eventType,
        host,
        audience: 'guest',
        when: w.label,
        brandName: ports.config.brandName,
        supportEmail: ports.config.supportEmail,
      })

      await ports.queue.send({
        kind: 'email',
        message: {
          to: booking.guestEmail,
          toName: booking.guestName,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        },
      })
    }
  }
}

/**
 * The morning digest (core/domain/digest.ts): for each host who opted in
 * and is due right now, today's confirmed meetings in their timezone.
 * The day is marked sent before the email is built, so an overlapping or
 * repeated tick sends nothing more; an empty day is marked too and sends
 * nothing at all.
 */
export async function sendDigests(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const { dailyDigestEmail } = await import('../core/email-templates.js')
  const { digestBookings, digestDue, digestRange } = await import('../core/domain/digest.js')
  for (const host of await repos.users.listDigestRecipients()) {
    const date = digestDue(host, now)
    if (!date) continue
    // One conditional UPDATE is the claim: an overlapping tick that reads
    // the same row loses here and sends nothing (caught by review).
    if (!(await repos.users.claimDigest(host.id, date))) continue
    const range = digestRange(date, host.tz)
    const todays = digestBookings(await repos.bookings.listForHost(host.id, range), range)
    if (todays.length === 0) continue
    const meetings: Array<{ booking: Booking; eventType: EventType; coHosts: User[] }> = []
    for (const booking of todays) {
      const eventType = await repos.eventTypes.byId(booking.eventTypeId)
      if (!eventType) continue
      const coHosts: User[] = []
      for (const id of booking.hostUserIds.filter((h) => h !== host.id)) {
        const u = await repos.users.byId(id)
        if (u) coHosts.push(u)
      }
      meetings.push({ booking, eventType, coHosts })
    }
    if (meetings.length === 0) continue
    const mail = dailyDigestEmail({
      brandName: ports.config.brandName,
      ...(ports.config.supportEmail ? { supportEmail: ports.config.supportEmail } : {}),
      host,
      date,
      meetings,
      dashboardUrl: `${ports.config.baseUrl.replace(/\/$/, '')}/dashboard`,
    })
    await ports.queue.send({ kind: 'email', message: { to: host.email, toName: host.name, subject: mail.subject, html: mail.html, text: mail.text } })
  }
}

// ---------------------------------------------------------------------------
// Calendar sync reconciler (SWA-1286)
// ---------------------------------------------------------------------------

/** A create sync that has not landed after this long is presumed lost. */
export const STUCK_SYNC_AFTER = 10 * MINUTE
/**
 * A booking that has failed at least once and whose sync state moved within
 * this window is still inside its own queue retry chain (backoff tops out at
 * 10 minutes, six deliveries), so the reconciler leaves it to that chain.
 */
export const RETRY_CHAIN_QUIET = 20 * MINUTE
/** Re-enqueued per tick, at most. */
export const STUCK_SYNC_BATCH = 25
/** How far ahead the drift check looks. Past meetings cannot be fixed. */
export const DRIFT_HORIZON = 30 * DAY
/**
 * Bookings drift-checked per tick, at most: one provider read per stored
 * event, so this bounds the tick's provider calls well inside any quota.
 */
export const DRIFT_BATCH = 20

/**
 * Two sweeps, each failure-isolated, and neither ever throws out of the cron.
 */
export async function reconcileCalendarSync(ports: EnginePorts, now: number): Promise<void> {
  await requeueStuckSyncs(ports, now).catch(() =>
    console.error(JSON.stringify({ source: 'punctual.calendar_sync', event: 'reconcile_sweep_failed', sweep: 'stuck' })),
  )
  await checkCalendarDrift(ports, now).catch(() =>
    console.error(JSON.stringify({ source: 'punctual.calendar_sync', event: 'reconcile_sweep_failed', sweep: 'drift' })),
  )
}

/**
 * (a) Confirmed, upcoming bookings still `pending` with no event ids ten
 * minutes after they were made: the create sync never ran (a crash between
 * the D1 commit and the enqueue) or is lost. Re-enqueue it. Safe to repeat:
 * a create skips connections that already hold an id, Google's event id is
 * stable so a twin answers 409 and is read back, and the confirmation is
 * claimed once. The re-enqueued message carries no manage token (only its
 * hash is stored), so a confirmation that had NOT gone out yet goes out
 * without the manage link; see the PR for that trade.
 */
export async function requeueStuckSyncs(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const stuck = await repos.bookings.listStuckCalendarSyncs(now, now - STUCK_SYNC_AFTER, STUCK_SYNC_BATCH, now - RETRY_CHAIN_QUIET)
  for (const booking of stuck) {
    try {
      await ports.queue.send({ kind: 'calendar.sync', bookingId: booking.id, action: 'create' })
      logSync('info', {
        event: 'requeued',
        bookingId: booking.id,
        stage: 'reconcile',
        category: booking.calendarSyncError ?? null,
        attempt: booking.calendarSyncAttempts ?? 0,
      })
    } catch (err) {
      // On the inline (no-TASKS) path the sync runs right here and a
      // retryable failure surfaces as this throw; the next tick tries again.
      logSync('warn', {
        event: 'requeue_failed',
        bookingId: booking.id,
        stage: 'reconcile',
        category: isCalendarSyncRetry(err) ? err.category : null,
      })
    }
  }
}

/**
 * (b) Drift: for synced, upcoming bookings (next 30 days, the least
 * recently verified first, `DRIFT_BATCH` per tick), read each stored event
 * back. Deleted, or start/end no longer the booking's: mark the booking
 * `drifted` and tell its hosts, once (the move is conditional in the
 * UPDATE). The guest's manage link then refuses to act on it.
 *
 * An event that cannot be read (connection needs reconnecting, provider
 * without `getEvent`, a provider error) is "unknown", never "drifted": a
 * failed read is not evidence the host moved anything. A rate limit ends
 * the sweep for this tick.
 */
export async function checkCalendarDrift(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const candidates = await repos.bookings.listCalendarDriftCandidates({ start: now, end: now + DRIFT_HORIZON }, DRIFT_BATCH)
  for (const booking of candidates) {
    let verdict: 'in_sync' | 'moved' | 'deleted' | 'unknown' = 'in_sync'
    for (const [connectionId, externalId] of Object.entries(booking.externalEventIds)) {
      const conn = await repos.connections.byId(connectionId)
      if (!conn || conn.syncStatus !== 'ok') {
        verdict = 'unknown'
        continue
      }
      let provider: ReturnType<EnginePorts['calendars']['get']>
      try {
        provider = ports.calendars.get(conn.provider)
      } catch {
        verdict = 'unknown'
        continue
      }
      if (!provider.getEvent) {
        verdict = 'unknown'
        continue
      }
      // Read from the calendar the event was written to. A 404 is evidence
      // of a deletion only when that calendar is known AND is still the
      // host's write calendar: an event written before migration 0018 has
      // no recorded calendar, and a host who repointed their write calendar
      // makes every older event look missing from the new one. Either way a
      // false "deleted" would refuse the guest's manage link, so: unknown.
      const writtenTo = booking.externalEventCalendars?.[connectionId]
      try {
        const snapshot = await provider.getEvent(conn, externalId, writtenTo)
        if (snapshot === null) {
          if (writtenTo !== undefined && writtenTo === conn.calendarIdWrite) {
            verdict = 'deleted'
            break
          }
          verdict = 'unknown'
          continue
        }
        if (snapshot.start !== booking.startUtc || snapshot.end !== booking.endUtc) {
          verdict = 'moved'
          break
        }
      } catch (err) {
        const category = classifyCalendarError(err)
        logSync('warn', { event: 'drift_read_failed', bookingId: booking.id, stage: 'drift_check', category, connectionId, provider: conn.provider })
        if (category === 'needs_reconnect') {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
        if (category === 'rate_limited') return
        verdict = 'unknown'
      }
    }

    if (verdict === 'moved' || verdict === 'deleted') {
      if (await repos.bookings.markCalendarDrifted(booking.id)) {
        logSync('warn', { event: 'drifted', bookingId: booking.id, stage: 'drift_check' })
        await alertCalendarSync(ports, repos, { ...booking, calendarSyncStatus: 'drifted' }, { kind: 'drifted', reason: verdict }).catch(() =>
          logSync('error', { event: 'alert_not_sent', bookingId: booking.id, stage: 'drift_check' }),
        )
      }
      continue
    }
    // In sync, or unknown: either way it goes to the back of the line, so
    // one unreadable booking cannot starve the rest of the batch.
    await repos.bookings.touchCalendarVerified(booking.id, now)
  }
}

/**
 * Opt-in telemetry (ADR-0006 §5).
 *
 * Counts only. No emails, names, slugs, URLs or calendar content — the payload
 * is small enough to read in full here, which is the point: the claim is
 * auditable rather than trusted.
 */
async function sendTelemetry(ports: EnginePorts, now: number): Promise<void> {
  // Once a day, not every 5 minutes.
  const hourOfDay = new Date(now).getUTCHours()
  const minute = new Date(now).getUTCMinutes()
  if (hourOfDay !== 3 || minute >= 5) return

  const repos = ports.repositories({ consistency: 'unconstrained' })
  const counts = await repos.telemetryCounts()

  await fetch('https://telemetry.punctual.sh/v1/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: '0.1.1',
      users: counts.users,
      eventTypes: counts.eventTypes,
      bookings: counts.bookings,
    }),
  }).catch(() => {})
}
