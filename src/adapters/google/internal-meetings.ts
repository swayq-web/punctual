/**
 * Google Calendar calls for INTERNAL meetings (staff-to-staff), reached only
 * through the `InternalApi` service-binding entrypoint (src/internal/).
 *
 * These differ from the booking path in `provider.ts` on purpose:
 *
 *  - `sendUpdates=all`: there is no Punctual confirmation email for an
 *    internal meeting, so Google's own invitation IS the invite.
 *  - Every event carries `extendedProperties.private.swayqInternalMeeting = "1"`
 *    and `swayqOrganizer = <email>`. Private extended properties live only on
 *    the organizer's copy of the event, so they are the ownership marker the
 *    reschedule and cancel paths check before touching anything.
 *  - Events live in Google only. Nothing is written to D1.
 *
 * Verified against the Calendar API v3 reference: `events.list` accepts
 * `privateExtendedProperty=key=value`; `events.insert` with a client-chosen
 * `id` answers 409 when it already exists; `events.patch` and
 * `events.delete` take `sendUpdates`.
 */

import type { CalendarConnection } from '../../core/domain/types.js'
import {
  type CalendarProviderDeps,
  expectOk,
  isRecord,
  providerFetch,
  readJson,
} from '../oauth.js'
import { googleConferenceUrl, toGoogleEvent } from './provider.js'

const API = 'https://www.googleapis.com/calendar/v3'

export const INTERNAL_MARKER_KEY = 'swayqInternalMeeting'
export const INTERNAL_ORGANIZER_KEY = 'swayqOrganizer'

/** What the internal API reads back from Google. Never includes the description. */
export interface InternalGoogleEvent {
  id: string
  status: string
  title: string
  start: number
  end: number
  htmlLink: string | null
  meetUrl: string | null
  attendees: Array<{ email: string; responseStatus: string | null }>
  /** `extendedProperties.private`, as Google stored it on this calendar's copy. */
  marker: string | null
  organizerMarker: string | null
}

export interface InsertInternalEvent {
  googleEventId: string
  conferenceRequestId: string
  title: string
  description: string
  start: number
  end: number
  timezone: string
  attendees: string[]
  organizerEmail: string
}

export type InsertOutcome =
  | { kind: 'created'; event: InternalGoogleEvent }
  /** 409: an event with this id already exists on the calendar — the caller decides what that means. */
  | { kind: 'exists' }

function eventUrl(calendarId: string, eventId: string): URL {
  return new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
}

export async function insertInternalEvent(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  calendarId: string,
  input: InsertInternalEvent,
): Promise<InsertOutcome> {
  const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
  url.searchParams.set('conferenceDataVersion', '1')
  url.searchParams.set('sendUpdates', 'all')

  const body = toGoogleEvent(
    {
      title: input.title,
      description: input.description,
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      attendees: input.attendees.map((email) => ({ email })),
    },
    input.conferenceRequestId,
  )
  body['id'] = input.googleEventId
  body['extendedProperties'] = {
    private: { [INTERNAL_MARKER_KEY]: '1', [INTERNAL_ORGANIZER_KEY]: input.organizerEmail },
  }

  const res = await providerFetch(deps, conn, url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) {
    // Drain so the connection is reusable; the body is not needed.
    await res.text().catch(() => '')
    return { kind: 'exists' }
  }
  const json = await readJson<unknown>(conn, res, 'events.insert')
  const parsed = parseInternalEvent(json)
  if (!parsed) throw new Error('events.insert returned an unreadable event')
  return { kind: 'created', event: parsed }
}

/** null when the event does not exist on this calendar (404/410). */
export async function getInternalEvent(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  calendarId: string,
  eventId: string,
): Promise<InternalGoogleEvent | null> {
  const url = eventUrl(calendarId, eventId)
  url.searchParams.set('conferenceDataVersion', '1')
  const res = await providerFetch(deps, conn, url.toString(), { method: 'GET' })
  if (res.status === 404 || res.status === 410) {
    await res.text().catch(() => '')
    return null
  }
  const json = await readJson<unknown>(conn, res, 'events.get')
  return parseInternalEvent(json)
}

/**
 * Re-read until Google has provisioned the Meet room. Bounded; a room still
 * pending after the last attempt is reported as null, never waited on.
 */
export async function resolveInternalMeetUrl(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  calendarId: string,
  eventId: string,
  attempts = 3,
  delayMs = 400,
): Promise<string | null> {
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < attempts; i++) {
    await wait(delayMs)
    try {
      const ev = await getInternalEvent(deps, conn, calendarId, eventId)
      if (!ev) return null
      if (ev.meetUrl) return ev.meetUrl
    } catch {
      // The event exists; a failed read costs the link, not the meeting.
      return null
    }
  }
  return null
}

export async function listInternalEvents(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  calendarId: string,
  range: { start: number; end: number },
): Promise<InternalGoogleEvent[]> {
  const out: InternalGoogleEvent[] = []
  let pageToken: string | undefined
  // A hard page cap: an internal-meeting list is short, and an unbounded loop
  // against a misbehaving API is a Worker that never returns.
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
    url.searchParams.set('privateExtendedProperty', `${INTERNAL_MARKER_KEY}=1`)
    url.searchParams.set('timeMin', new Date(range.start).toISOString())
    url.searchParams.set('timeMax', new Date(range.end).toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    url.searchParams.set('conferenceDataVersion', '1')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await providerFetch(deps, conn, url.toString(), { method: 'GET' })
    const json = await readJson<unknown>(conn, res, 'events.list')
    const items = isRecord(json) && Array.isArray(json['items']) ? json['items'] : []
    for (const item of items) {
      const ev = parseInternalEvent(item)
      if (ev) out.push(ev)
    }
    pageToken = isRecord(json) && typeof json['nextPageToken'] === 'string' ? json['nextPageToken'] : undefined
    if (!pageToken) break
  }
  return out
}

export async function patchInternalEventTime(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  calendarId: string,
  eventId: string,
  times: { start: number; end: number; timezone: string },
): Promise<InternalGoogleEvent | null> {
  const url = eventUrl(calendarId, eventId)
  // Version 1 so Google keeps the existing conference; no createRequest, so
  // the Meet link already in everyone's inbox stays valid.
  url.searchParams.set('conferenceDataVersion', '1')
  url.searchParams.set('sendUpdates', 'all')
  const res = await providerFetch(deps, conn, url.toString(), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      start: { dateTime: new Date(times.start).toISOString(), timeZone: times.timezone },
      end: { dateTime: new Date(times.end).toISOString(), timeZone: times.timezone },
    }),
  })
  const json = await readJson<unknown>(conn, res, 'events.patch')
  return parseInternalEvent(json)
}

/** true when deleted now, false when it was already gone (404/410). */
export async function deleteInternalEvent(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  const url = eventUrl(calendarId, eventId)
  url.searchParams.set('sendUpdates', 'all')
  const res = await providerFetch(deps, conn, url.toString(), { method: 'DELETE' })
  if (res.status === 404 || res.status === 410) {
    await res.text().catch(() => '')
    return false
  }
  await expectOk(conn, res, 'events.delete')
  return true
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

export function parseInternalEvent(json: unknown): InternalGoogleEvent | null {
  if (!isRecord(json) || typeof json['id'] !== 'string') return null
  const start = parseEventTime(json['start'])
  const end = parseEventTime(json['end'])
  if (start === null || end === null) return null

  const ext = isRecord(json['extendedProperties']) ? json['extendedProperties'] : {}
  const priv = isRecord(ext['private']) ? ext['private'] : {}
  const marker = typeof priv[INTERNAL_MARKER_KEY] === 'string' ? priv[INTERNAL_MARKER_KEY] : null
  const organizerMarker = typeof priv[INTERNAL_ORGANIZER_KEY] === 'string' ? priv[INTERNAL_ORGANIZER_KEY] : null

  const attendees: InternalGoogleEvent['attendees'] = []
  if (Array.isArray(json['attendees'])) {
    for (const a of json['attendees']) {
      if (!isRecord(a) || typeof a['email'] !== 'string') continue
      attendees.push({
        email: a['email'].trim().toLowerCase(),
        responseStatus: typeof a['responseStatus'] === 'string' ? a['responseStatus'] : null,
      })
    }
  }

  return {
    id: json['id'],
    status: typeof json['status'] === 'string' ? json['status'] : 'confirmed',
    title: typeof json['summary'] === 'string' ? json['summary'] : '',
    start,
    end,
    htmlLink: typeof json['htmlLink'] === 'string' ? json['htmlLink'] : null,
    meetUrl: googleConferenceUrl(json)?.conferenceUrl ?? null,
    attendees,
    marker,
    organizerMarker,
  }
}

function parseEventTime(value: unknown): number | null {
  if (!isRecord(value)) return null
  const dt = value['dateTime']
  if (typeof dt === 'string') {
    const ms = Date.parse(dt)
    return Number.isNaN(ms) ? null : ms
  }
  // All-day events are never created by this API; reading one is not an error,
  // but it has no instant to report, so it is skipped by the caller.
  return null
}
