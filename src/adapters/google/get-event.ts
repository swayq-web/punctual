/**
 * Google: read back one event this engine wrote, for the drift check
 * (adapters/scheduled.ts, SWA-1286).
 *
 * A separate file from provider.ts on purpose: provider.ts is owned by a
 * parallel change, and this is attached to the provider in providers.ts.
 * Integrator: fold it into `createGoogleProvider` once both have landed.
 *
 * Reads only `start`, `end` and `status`. The `calendar.events` scope already
 * granted covers it; nothing about the event's contents is looked at.
 */

import type { CalendarConnection } from '../../core/domain/types.js'
import type { ExternalEventSnapshot } from '../../ports.js'
import { CalendarApiError, type CalendarProviderDeps, isRecord, providerFetch, readJson } from '../oauth.js'

const API = 'https://www.googleapis.com/calendar/v3'

export function createGoogleGetEvent(deps: CalendarProviderDeps) {
  /**
   * `calendarId` is the calendar the event was WRITTEN to (stored per event
   * since migration 0018). Falls back to the connection's current write
   * calendar for an event written before that; the caller then treats a 404
   * as "unknown", because the host may simply have repointed their calendar.
   */
  return async function getEvent(
    conn: CalendarConnection,
    externalId: string,
    calendarId?: string,
  ): Promise<ExternalEventSnapshot | null> {
    const calendar = calendarId ?? conn.calendarIdWrite
    if (calendar === null) {
      throw new CalendarApiError('google', `connection ${conn.id} has no write calendar configured`)
    }
    const url = new URL(
      `${API}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(externalId)}`,
    )
    url.searchParams.set('fields', 'status,start,end')
    const res = await providerFetch(deps, conn, url.toString(), { method: 'GET' })
    // Gone for good, or never there: the event was deleted.
    if (res.status === 404 || res.status === 410) return null
    const json = await readJson<unknown>(conn, res, 'events.get')
    return parseGoogleEventSnapshot(json)
  }
}

/**
 * Pure, so the shapes are pinned by tests. A deleted event Google still
 * remembers comes back 200 with `status: 'cancelled'`: that is gone too.
 */
export function parseGoogleEventSnapshot(json: unknown): ExternalEventSnapshot | null {
  if (!isRecord(json)) throw new CalendarApiError('google', 'events.get returned no event')
  if (json['status'] === 'cancelled') return null
  return { start: googleTime(json['start'], 'start'), end: googleTime(json['end'], 'end') }
}

function googleTime(value: unknown, which: string): number {
  if (isRecord(value)) {
    // Timed events carry an RFC 3339 dateTime with an offset.
    if (typeof value['dateTime'] === 'string') {
      const ms = Date.parse(value['dateTime'])
      if (!Number.isNaN(ms)) return ms
    }
    // Someone turned it into an all-day event: it has moved, whatever day.
    if (typeof value['date'] === 'string') {
      const ms = Date.parse(`${value['date']}T00:00:00Z`)
      if (!Number.isNaN(ms)) return ms
    }
  }
  throw new CalendarApiError('google', `events.get: unreadable ${which}`)
}
