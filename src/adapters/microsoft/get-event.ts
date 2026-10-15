/**
 * Microsoft Graph: read back one event this engine wrote, for the drift
 * check (adapters/scheduled.ts, SWA-1286). Kept beside provider.ts rather
 * than in it, for symmetry with google/get-event.ts; attached in providers.ts.
 *
 * `/me/events/{id}` resolves across every calendar in the mailbox, the same
 * address updateEvent and deleteEvent use. The UTC Prefer header makes
 * `parseGraphDateTime` safe to apply.
 */

import type { CalendarConnection } from '../../core/domain/types.js'
import type { ExternalEventSnapshot } from '../../ports.js'
import { CalendarApiError, type CalendarProviderDeps, isRecord, providerFetch, readJson } from '../oauth.js'
import { parseGraphDateTime } from './provider.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'

export function createMicrosoftGetEvent(deps: CalendarProviderDeps) {
  return async function getEvent(conn: CalendarConnection, externalId: string): Promise<ExternalEventSnapshot | null> {
    const res = await providerFetch(
      deps,
      conn,
      `${GRAPH}/me/events/${encodeURIComponent(externalId)}?$select=start,end,isCancelled`,
      { method: 'GET', headers: { prefer: 'outlook.timezone="UTC"' } },
    )
    if (res.status === 404 || res.status === 410) return null
    const json = await readJson<unknown>(conn, res, 'events.get')
    return parseGraphEventSnapshot(json)
  }
}

export function parseGraphEventSnapshot(json: unknown): ExternalEventSnapshot | null {
  if (!isRecord(json)) throw new CalendarApiError('microsoft', 'events.get returned no event')
  if (json['isCancelled'] === true) return null
  return { start: parseGraphDateTime(json['start'], 'events.get'), end: parseGraphDateTime(json['end'], 'events.get') }
}
