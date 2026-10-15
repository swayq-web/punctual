/**
 * Durable calendar sync (SWA-1286).
 *
 * Before this, a calendar write that failed was caught, logged, and the
 * queue message acked: the booking said "confirmed", no event existed, and
 * nothing retried or told anyone. These tests pin what replaced that:
 *
 *   - a retryable provider error rethrows so the queue retries, with backoff,
 *     and the booking records the attempt
 *   - a permanent one marks the booking failed at once and alerts the host
 *     and the instance admins, without burning retries
 *   - retries never make a second event or a second confirmation, including
 *     the nasty case: Google created the event but the answer never arrived
 *   - the dead-letter consumer fails the booking and alerts, once
 *   - the 5-minute reconciler re-enqueues a lost create and detects drift
 *
 * The calendar here is the REAL Google adapter (and providers.ts wiring)
 * over a scripted, stateful Google, so the 409 read-back path is the one
 * that ships, not a stub's idea of it.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Booking, CalendarConnection, EventType, OAuthTokens, User } from '../../src/core/domain/types.js'
import type { EmailMessage, EnginePorts, QueueMessage } from '../../src/ports.js'
import { handleOne, handleQueueBatch, handleDeadLetter, isDeadLetterQueue } from '../../src/adapters/queue/consumer.js'
import { checkCalendarDrift, requeueStuckSyncs, reconcileCalendarSync } from '../../src/adapters/scheduled.js'
import { createCalendarProviders } from '../../src/adapters/providers.js'
import { createEnvOAuthCredentials, CalendarApiError, CalendarReconnectRequiredError } from '../../src/adapters/oauth.js'
import { classifyCalendarError } from '../../src/adapters/calendar-sync-errors.js'
import { createFakeRepositories } from '../../src/testing/fakes.js'
import { retryDelaySeconds } from '../../src/core/domain/calendar-sync.js'
import { parseGoogleEventSnapshot } from '../../src/adapters/google/get-event.js'
import { parseGraphEventSnapshot } from '../../src/adapters/microsoft/get-event.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 16, 12, 0)
const START = NOW + 2 * 24 * HOUR

// ---------------------------------------------------------------------------
// A stateful Google: events persist across calls, ids are honoured, a reused
// id answers 409, exactly like the real API's "identifier already exists".
// ---------------------------------------------------------------------------

type GoogleEvent = { id: string; status: string; start: { dateTime: string }; end: { dateTime: string } }

function statefulGoogle() {
  const events = new Map<string, GoogleEvent>()
  /** Scripted failures, consumed one per events.insert. */
  const insertScript: Array<'ok' | 'lose-answer' | { status: number; body?: string } | 'network'> = []
  let inserts = 0
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const m = /\/calendars\/[^/]+\/events(?:\/([^/?]+))?$/.exec(url.pathname)
    if (!m) return json(501, { error: 'no route' })
    const id = m[1] ? decodeURIComponent(m[1]) : undefined

    if (method === 'POST' && !id) {
      inserts += 1
      const step = insertScript.shift() ?? 'ok'
      if (step === 'network') throw new TypeError('fetch failed')
      if (typeof step === 'object') return json(step.status, { error: { message: step.body ?? 'scripted' } })
      const body = JSON.parse(String(init?.body)) as { id: string; start: { dateTime: string }; end: { dateTime: string } }
      if (events.has(body.id)) return json(409, { error: { message: 'The requested identifier already exists.' } })
      const ev: GoogleEvent = { id: body.id, status: 'confirmed', start: body.start, end: body.end }
      events.set(body.id, ev)
      // Google committed the event; the response is lost on the way back.
      if (step === 'lose-answer') throw new DOMException('The operation timed out.', 'TimeoutError')
      return json(200, ev)
    }
    if (method === 'GET' && id) {
      const ev = events.get(id)
      return ev ? json(200, ev) : json(404, { error: { message: 'Not Found' } })
    }
    if (method === 'PATCH' && id) {
      const ev = events.get(id)
      if (!ev) return json(404, {})
      const body = JSON.parse(String(init?.body)) as Partial<GoogleEvent>
      events.set(id, { ...ev, ...body, id })
      return json(200, events.get(id))
    }
    if (method === 'DELETE' && id) {
      events.delete(id)
      return new Response(null, { status: 204 })
    }
    return json(501, { error: 'no route' })
  }) as typeof globalThis.fetch

  return { events, insertScript, fetchImpl, inserts: () => inserts }
}

const TOKENS: OAuthTokens = { accessToken: 'ya29.valid', refreshToken: '1//r', expiresAt: NOW + 10 * HOUR, scope: 'x' }

// ---------------------------------------------------------------------------
// Harness: fake repositories (the shipped in-memory ones, extended with the
// few lookups the sync and notify paths make), a captured queue, real Google.
// ---------------------------------------------------------------------------

const host: User = {
  id: 'u_host', email: 'grace@example.com', name: 'Grace', tz: 'UTC', slug: 'grace',
  avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member', createdAt: 0,
}
const admin: User = { ...host, id: 'u_admin', email: 'admin@example.com', name: 'Admin', slug: 'admin', role: 'admin' }

const eventType: EventType = {
  id: 'et_1', ownerUserId: 'u_host', ownerTeamId: null, schedulingType: 'personal', slug: 'intro',
  title: 'Intro call', description: '', durationMinutes: 30, slotIntervalMinutes: null,
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, maxHorizonDays: 60, maxPerDay: null,
  locationType: 'in_person', locationValue: 'Office', questions: [], active: true, createdAt: 0, scheduleId: null,
}

const conn: CalendarConnection = {
  id: 'conn_1', userId: 'u_host', provider: 'google', providerAccountEmail: 'grace@example.com',
  encryptedTokens: 'x', keyVersion: 1, calendarIdsRead: ['primary'], calendarIdWrite: 'primary',
  syncStatus: 'ok', createdAt: 0,
}

function makeBooking(over: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1', eventTypeId: 'et_1', hostUserId: 'u_host', hostUserIds: ['u_host'],
    guestName: 'Ada Guest', guestEmail: 'ada@example.com', guestTimezone: 'UTC',
    startUtc: START, endUtc: START + 30 * MINUTE, localDate: '2026-10-18', status: 'confirmed',
    answers: {}, externalEventIds: {}, conferenceUrl: null, rescheduleOf: null, rescheduledTo: null,
    manageTokenHash: 'hash', cancelledAt: null, createdAt: NOW - HOUR,
    calendarSyncStatus: 'pending', calendarSyncAttempts: 0, calendarSyncError: null, calendarSyncedAt: null,
    ...over,
  }
}

function harness(opts: { booking?: Partial<Booking>; connections?: CalendarConnection[] } = {}) {
  const google = statefulGoogle()
  const repos = createFakeRepositories()
  repos.seedUser(host)
  repos.seedUser(admin)
  for (const c of opts.connections ?? [conn]) repos.state.connections.set(c.id, c)
  repos.seedBooking(makeBooking(opts.booking))

  const connectionStatus: Record<string, string> = {}
  // The shipped fakes leave these unimplemented on purpose; this flow needs them.
  Object.assign(repos.eventTypes as object, { byId: async () => eventType })
  Object.assign(repos.eventTypeHosts as object, { forEventType: async () => [] })
  Object.assign(repos.webhooks as object, { listForUser: async () => [] })
  Object.assign(repos.connections as object, {
    listForUser: async (userId: string) => [...repos.state.connections.values()].filter((c) => c.userId === userId),
    updateSyncStatus: async (id: string, status: CalendarConnection['syncStatus']) => {
      connectionStatus[id] = status
      const c = repos.state.connections.get(id)
      if (c) repos.state.connections.set(id, { ...c, syncStatus: status })
    },
  })
  Object.assign(repos.users as object, { listAll: async () => [...repos.state.users.values()] })

  const queued: QueueMessage[] = []
  const calendars = createCalendarProviders({
    oauth: createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' }, 'https://punctual.test'),
    crypto: { decrypt: async () => JSON.stringify(TOKENS), randomToken: (n = 16) => 'r'.repeat(n) },
    clock: { now: () => NOW },
    sleep: async () => {},
    onTokensRefreshed: async () => {},
    fetch: google.fetchImpl,
  })

  const ports = {
    clock: { now: () => NOW },
    crypto: { randomToken: (n = 16) => 'r'.repeat(n), hash: async (v: string) => `h:${v}`, sign: async () => 'sig' },
    config: { baseUrl: 'https://punctual.test', brandName: 'Punctual', supportEmail: 'help@punctual.test' },
    calendars,
    queue: { send: async (m: QueueMessage) => void queued.push(m), sendBatch: async () => {} },
    repositories: () => repos,
  } as unknown as EnginePorts

  const emails = (): EmailMessage[] => queued.flatMap((m) => (m.kind === 'email' ? [m.message] : []))
  return {
    google,
    repos,
    ports,
    queued,
    connectionStatus,
    booking: () => repos.state.bookings.get('bk_1')!,
    emails,
    confirmations: () => emails().filter((e) => !/^Calendar sync failed|^Meeting changed/.test(e.subject) && e.to === 'ada@example.com'),
    alerts: () => emails().filter((e) => /^Calendar sync failed|^Meeting changed/.test(e.subject)),
    create: { kind: 'calendar.sync', bookingId: 'bk_1', action: 'create', manageToken: 'tok' } as const,
  }
}

/** A Cloudflare MessageBatch of one, recording what the consumer decided. */
function batchOf(body: QueueMessage, attempts: number, queue = 'punctual-tasks') {
  const message = { body, attempts, id: 'm1', timestamp: new Date(NOW), ack: vi.fn(), retry: vi.fn() }
  return { batch: { queue, messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch, message }
}

// ---------------------------------------------------------------------------

describe('classifying provider errors', () => {
  it('retryable: 429, 5xx, Google 403 rate limits, transport errors', () => {
    expect(classifyCalendarError(new CalendarApiError('google', 'x', { status: 429 }))).toBe('rate_limited')
    expect(classifyCalendarError(new CalendarApiError('google', 'x', { status: 403, body: '{"reason":"rateLimitExceeded"}' }))).toBe('rate_limited')
    expect(classifyCalendarError(new CalendarApiError('google', 'x', { status: 503 }))).toBe('provider_unavailable')
    expect(classifyCalendarError(new TypeError('fetch failed'))).toBe('network')
    expect(classifyCalendarError(new DOMException('timed out', 'TimeoutError'))).toBe('network')
  })
  it('permanent: revoked grant, 403 permission, 404 calendar, a connection with no write calendar', () => {
    expect(classifyCalendarError(new CalendarReconnectRequiredError('google', 'c', 'revoked'))).toBe('needs_reconnect')
    expect(classifyCalendarError(new CalendarApiError('google', 'x', { status: 403, body: 'forbidden' }))).toBe('permission_denied')
    expect(classifyCalendarError(new CalendarApiError('google', 'x', { status: 404 }))).toBe('not_found')
    expect(classifyCalendarError(new CalendarApiError('google', 'no write calendar configured'))).toBe('rejected')
  })
  it('backs off exponentially, capped at ten minutes', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([10, 30, 90, 270, 600, 600])
  })
})

describe('retries never duplicate', () => {
  it('a duplicate queue delivery makes one event and one confirmation', async () => {
    const h = harness()
    await handleQueueBatch(batchOf(h.create, 1).batch, h.ports)
    await handleQueueBatch(batchOf(h.create, 1).batch, h.ports)

    expect(h.google.events.size).toBe(1)
    expect(h.google.inserts()).toBe(1)
    expect(h.confirmations()).toHaveLength(1)
    expect(h.booking().calendarSyncStatus).toBe('synced')
  })

  it('Google created the event but the answer timed out: the retry reads it back (409), one event, one email', async () => {
    const h = harness()
    h.google.insertScript.push('lose-answer')

    const first = batchOf(h.create, 1)
    await handleQueueBatch(first.batch, h.ports)
    expect(first.message.retry).toHaveBeenCalledWith({ delaySeconds: 10 })
    expect(first.message.ack).not.toHaveBeenCalled()
    // The first delivery held the confirmation back so the retry can carry the result.
    expect(h.confirmations()).toHaveLength(0)

    const second = batchOf(h.create, 2)
    await handleQueueBatch(second.batch, h.ports)
    expect(second.message.ack).toHaveBeenCalled()

    expect(h.google.events.size).toBe(1)
    expect(h.google.inserts()).toBe(2) // the 409, not a twin
    expect(Object.values(h.booking().externalEventIds)).toEqual([...h.google.events.keys()])
    expect(h.confirmations()).toHaveLength(1)
    expect(h.booking().calendarSyncStatus).toBe('synced')
  })
})

describe('a retryable error is retried, not acked', () => {
  it('rethrows for message.retry() with backoff, attempts++, status pending with the category', async () => {
    const h = harness()
    h.google.insertScript.push({ status: 503 })

    const { batch, message } = batchOf(h.create, 1)
    await handleQueueBatch(batch, h.ports)

    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 })
    expect(h.booking()).toMatchObject({ calendarSyncStatus: 'pending', calendarSyncAttempts: 1, calendarSyncError: 'provider_unavailable' })
    expect(h.alerts()).toHaveLength(0)
  })

  it('after the first delivery the confirmation goes out anyway, and the calendar is still retried', async () => {
    const h = harness()
    h.google.insertScript.push({ status: 429 })
    const { batch, message } = batchOf(h.create, 2)
    await handleQueueBatch(batch, h.ports)
    expect(h.confirmations()).toHaveLength(1)
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
  })

  it('on the inline (no-queue) path the confirmation is never held', async () => {
    const h = harness()
    h.google.insertScript.push('network')
    await expect(handleOne(h.create, h.ports)).rejects.toThrow(/will be retried: network/)
    expect(h.confirmations()).toHaveLength(1)
  })
})

describe('a permanent error fails the booking at once', () => {
  it('403 permission: failed, acked (no retries burned), host and admin alerted, guest confirmed', async () => {
    const h = harness()
    h.google.insertScript.push({ status: 403, body: 'The user does not have writer access' })

    const { batch, message } = batchOf(h.create, 1)
    await handleQueueBatch(batch, h.ports)

    expect(message.ack).toHaveBeenCalled()
    expect(message.retry).not.toHaveBeenCalled()
    expect(h.booking()).toMatchObject({ calendarSyncStatus: 'failed', calendarSyncError: 'permission_denied' })
    expect(h.alerts().map((e) => e.to).sort()).toEqual(['admin@example.com', 'grace@example.com'])
    // The alert names no guest detail and no provider body.
    for (const a of h.alerts()) {
      expect(a.text).not.toContain('ada@example.com')
      expect(a.text).not.toContain('Ada Guest')
      expect(a.text).not.toContain('writer access')
    }
    // The guest gets their confirmation, never the failure.
    expect(h.confirmations()).toHaveLength(1)
    expect(h.emails().filter((e) => e.to === 'ada@example.com').every((e) => !/sync failed/i.test(e.subject))).toBe(true)
  })

  it('a second failing delivery does not alert twice', async () => {
    const h = harness()
    h.google.insertScript.push({ status: 404 }, { status: 404 })
    await handleQueueBatch(batchOf(h.create, 1).batch, h.ports)
    await handleQueueBatch(batchOf(h.create, 1).batch, h.ports)
    expect(h.alerts()).toHaveLength(2) // host + admin, once
  })
})

describe('dead-letter queue', () => {
  it('routes *-dlq batches to the dead-letter handler', () => {
    expect(isDeadLetterQueue('punctual-tasks-dlq')).toBe(true)
    expect(isDeadLetterQueue('punctual-tasks')).toBe(false)
  })

  it('a create that exhausted retries: failed, alerted once, and the guest still gets a confirmation', async () => {
    const h = harness({ booking: { calendarSyncStatus: 'pending', calendarSyncError: 'rate_limited', calendarSyncAttempts: 6 } })

    const { batch, message } = batchOf(h.create, 1, 'punctual-tasks-dlq')
    await handleQueueBatch(batch, h.ports)
    expect(message.ack).toHaveBeenCalled()
    // Nothing is retried against the provider from the DLQ.
    expect(h.google.inserts()).toBe(0)
    expect(h.booking()).toMatchObject({ calendarSyncStatus: 'failed', calendarSyncError: 'rate_limited', calendarSyncAttempts: 7 })
    expect(h.alerts()).toHaveLength(2)
    expect(h.confirmations()).toHaveLength(1)

    await handleQueueBatch(batchOf(h.create, 1, 'punctual-tasks-dlq').batch, h.ports)
    expect(h.alerts()).toHaveLength(2)
    expect(h.confirmations()).toHaveLength(1)
  })

  it('does not fail a booking a later pass already synced', async () => {
    const h = harness({ booking: { calendarSyncStatus: 'synced', externalEventIds: { conn_1: 'e1' } } })
    await handleDeadLetter({ kind: 'calendar.sync', bookingId: 'bk_1', action: 'update' }, h.ports)
    expect(h.booking().calendarSyncStatus).toBe('synced')
    expect(h.alerts()).toHaveLength(0)
  })
})

describe('reconciler: lost create syncs', () => {
  it('re-enqueues a confirmed, upcoming booking stuck pending with no event ids for over 10 minutes', async () => {
    const h = harness({ booking: { createdAt: NOW - 11 * MINUTE } })
    await requeueStuckSyncs(h.ports, NOW)
    expect(h.queued).toEqual([{ kind: 'calendar.sync', bookingId: 'bk_1', action: 'create' }])

    // And the re-enqueued message, delivered, actually heals it.
    await handleOne(h.queued[0]!, h.ports, { attempts: 1 })
    expect(h.google.events.size).toBe(1)
    expect(h.booking().calendarSyncStatus).toBe('synced')
  })

  it('leaves alone: a fresh booking, a synced one, a failed one, a past one', async () => {
    for (const patch of [
      { createdAt: NOW - 5 * MINUTE },
      { createdAt: NOW - HOUR, calendarSyncStatus: 'synced' as const },
      { createdAt: NOW - HOUR, calendarSyncStatus: 'failed' as const },
      { createdAt: NOW - 3 * HOUR, startUtc: NOW - HOUR, endUtc: NOW - 30 * MINUTE },
    ]) {
      const h = harness({ booking: patch })
      await requeueStuckSyncs(h.ports, NOW)
      expect(h.queued).toEqual([])
    }
  })
})

describe('reconciler: drift', () => {
  async function synced() {
    const h = harness()
    await handleOne(h.create, h.ports, { attempts: 1 })
    expect(h.booking().calendarSyncStatus).toBe('synced')
    h.queued.length = 0
    return h
  }

  it('an event moved on the calendar: drifted, host told once (not the admin)', async () => {
    const h = await synced()
    const [id, ev] = [...h.google.events.entries()][0]!
    h.google.events.set(id, { ...ev, start: { dateTime: new Date(START + HOUR).toISOString() }, end: { dateTime: new Date(START + 90 * MINUTE).toISOString() } })

    await checkCalendarDrift(h.ports, NOW)
    expect(h.booking().calendarSyncStatus).toBe('drifted')
    expect(h.alerts().map((e) => e.to)).toEqual(['grace@example.com'])

    await checkCalendarDrift(h.ports, NOW + 5 * MINUTE)
    expect(h.alerts()).toHaveLength(1)
  })

  it('an event deleted on the calendar: drifted', async () => {
    const h = await synced()
    h.google.events.clear()
    await checkCalendarDrift(h.ports, NOW)
    expect(h.booking().calendarSyncStatus).toBe('drifted')
    expect(h.alerts()[0]!.text).toContain('was deleted from the calendar')
  })

  it('an event still in place: stays synced, marked verified', async () => {
    const h = await synced()
    await checkCalendarDrift(h.ports, NOW + MINUTE)
    expect(h.booking().calendarSyncStatus).toBe('synced')
    expect(h.booking().calendarSyncedAt).toBe(NOW + MINUTE)
    expect(h.alerts()).toHaveLength(0)
  })

  it('an unreadable event is unknown, never drifted', async () => {
    const h = await synced()
    const real = h.ports.calendars.get('google')
    ;(h.ports as { calendars: unknown }).calendars = {
      get: () => ({ ...real, getEvent: async () => { throw new CalendarApiError('google', 'x', { status: 500 }) } }),
      available: () => ['google'],
    }
    await checkCalendarDrift(h.ports, NOW)
    expect(h.booking().calendarSyncStatus).toBe('synced')
  })

  it('a redelivered create does not wash a drift out; never throws out of the cron', async () => {
    const h = await synced()
    h.google.events.clear()
    await checkCalendarDrift(h.ports, NOW)
    await handleOne(h.create, h.ports, { attempts: 1 })
    expect(h.booking().calendarSyncStatus).toBe('drifted')

    const broken = { ...h.ports, repositories: () => { throw new Error('D1 down') } } as unknown as EnginePorts
    await expect(reconcileCalendarSync(broken, NOW)).resolves.toBeUndefined()
  })
})

describe('provider read-back parsers', () => {
  it('Google: timed, all-day, cancelled', () => {
    expect(parseGoogleEventSnapshot({ status: 'confirmed', start: { dateTime: '2026-10-18T12:00:00+02:00' }, end: { dateTime: '2026-10-18T12:30:00+02:00' } }))
      .toEqual({ start: Date.UTC(2026, 9, 18, 10), end: Date.UTC(2026, 9, 18, 10, 30) })
    expect(parseGoogleEventSnapshot({ status: 'confirmed', start: { date: '2026-10-18' }, end: { date: '2026-10-19' } })!.start).toBe(Date.UTC(2026, 9, 18))
    expect(parseGoogleEventSnapshot({ status: 'cancelled' })).toBeNull()
  })
  it('Graph: UTC dateTime, cancelled', () => {
    expect(parseGraphEventSnapshot({ start: { dateTime: '2026-10-18T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-18T10:30:00.0000000', timeZone: 'UTC' } }))
      .toEqual({ start: Date.UTC(2026, 9, 18, 10), end: Date.UTC(2026, 9, 18, 10, 30) })
    expect(parseGraphEventSnapshot({ isCancelled: true })).toBeNull()
  })
})
