import { describe, expect, it } from 'vitest'
import { createInternalService, type InternalService } from '../../src/internal/service.js'
import { createEnvOAuthCredentials, CalendarApiError } from '../../src/adapters/oauth.js'
import { createFakeRepositories, fakeConfig, type FakeRepositories } from '../../src/testing/fakes.js'
import type { CalendarProvider } from '../../src/ports.js'
import type { CalendarConnection, EventType, Interval, OAuthTokens, WeeklySchedule } from '../../src/core/domain/types.js'
import type { InternalError } from '../../src/internal/contract.js'

/**
 * The internal scheduling RPC (SWA-1289), against fake ports and a scripted
 * Google. The two guards that matter most, the attendee guard and the
 * ownership guard, each have a test that fails when the guard is removed
 * (see the PR body for the revert proofs).
 */

const TOKEN = 'test-internal-service-token-0123456789'
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-19T05:00:00Z') // Monday 07:00 in Copenhagen
const TZ = 'Europe/Copenhagen'

const JH = 'jh@swayq.com'
const PETER = 'peter@swayq.com'
const EMMA = 'emma@swayq.com'

const WEEKDAYS_9_17: WeeklySchedule = [
  [],
  [{ startMinute: 540, endMinute: 1020 }],
  [{ startMinute: 540, endMinute: 1020 }],
  [{ startMinute: 540, endMinute: 1020 }],
  [{ startMinute: 540, endMinute: 1020 }],
  [{ startMinute: 540, endMinute: 1020 }],
  [],
]

// ---------------------------------------------------------------------------
// A scripted Google Calendar: an in-memory event store behind fetch.
// ---------------------------------------------------------------------------

interface StoredEvent {
  id: string
  status: string
  summary: string
  description?: string
  start: { dateTime: string }
  end: { dateTime: string }
  attendees: Array<{ email: string; responseStatus?: string }>
  extendedProperties?: { private?: Record<string, string> }
  hangoutLink?: string
  htmlLink: string
}

interface Call {
  method: string
  url: URL
  body: unknown
}

function scriptedGoogle() {
  /** calendarId -> eventId -> event */
  const calendars = new Map<string, Map<string, StoredEvent>>()
  const calls: Call[] = []
  const cal = (id: string) => {
    let c = calendars.get(id)
    if (!c) calendars.set(id, (c = new Map()))
    return c
  }
  const json = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
    const m = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
    if (!m) return json(501, { error: 'no route' })
    const calendarId = decodeURIComponent(m[1]!)
    const eventId = m[2] ? decodeURIComponent(m[2]) : null
    const store = cal(calendarId)

    if (method === 'POST' && !eventId) {
      const id = body.id as string
      if (store.has(id)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.' } })
      const ev: StoredEvent = {
        ...body,
        status: 'confirmed',
        hangoutLink: `https://meet.google.com/${id.slice(2, 5)}-xyz`,
        htmlLink: `https://calendar.google.com/event?eid=${id}`,
      }
      store.set(id, ev)
      return json(200, ev)
    }
    if (method === 'GET' && !eventId) {
      const filter = url.searchParams.get('privateExtendedProperty')
      const [k, v] = (filter ?? '').split('=')
      const items = [...store.values()].filter((e) => !filter || e.extendedProperties?.private?.[k!] === v)
      return json(200, { items })
    }
    const ev = eventId ? store.get(eventId) : undefined
    if (method === 'GET') return ev ? json(200, ev) : json(404, { error: { code: 404 } })
    if (method === 'PATCH') {
      if (!ev) return json(404, { error: { code: 404 } })
      Object.assign(ev, body)
      return json(200, ev)
    }
    if (method === 'DELETE') {
      if (!ev) return json(410, { error: { code: 410 } })
      store.delete(ev.id)
      return json(204, null)
    }
    return json(501, { error: 'no route' })
  }) as typeof globalThis.fetch

  return { fetchImpl, calls, calendars, cal }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const VALID_TOKENS: OAuthTokens = {
  accessToken: 'ya29.valid',
  refreshToken: '1//refresh',
  expiresAt: NOW + 10 * HOUR,
  scope: 'https://www.googleapis.com/auth/calendar.events',
}

function conn(userId: string, email: string, over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: `conn_${userId}`,
    userId,
    provider: 'google',
    providerAccountEmail: email,
    encryptedTokens: 'unused',
    keyVersion: 1,
    calendarIdsRead: ['primary'],
    calendarIdWrite: email,
    syncStatus: 'ok',
    createdAt: 0,
    ...over,
  }
}

interface Harness {
  repos: FakeRepositories
  svc: InternalService
  google: ReturnType<typeof scriptedGoogle>
  /** userId -> busy intervals, or an Error to throw from getBusy. */
  busy: Map<string, Interval[] | Error>
  getBusyCalls: string[]
  eventTypes: EventType[]
}

function harness(opts: { serviceToken?: string | undefined; allowedDomains?: string[] } = {}): Harness {
  const repos = createFakeRepositories()
  const google = scriptedGoogle()
  const busy = new Map<string, Interval[] | Error>()
  const getBusyCalls: string[] = []
  const eventTypes: EventType[] = []

  for (const [id, email] of [
    ['u_jh', JH],
    ['u_peter', PETER],
    ['u_emma', EMMA],
  ] as const) {
    repos.seedUser({ id, email, tz: TZ, slug: id.slice(2) })
    void repos.connections.create(conn(id, email))
    void repos.availability.create(id, {
      id: `sch_${id}`,
      userId: id,
      name: 'Working hours',
      isDefault: true,
      timezone: TZ,
      weekly: WEEKDAYS_9_17,
      overrides: [],
    })
  }

  const r = repos as unknown as Record<string, unknown>
  r['slotLocks'] = {
    async busyBuckets() {
      return new Map()
    },
    async activeHolds() {
      return new Map()
    },
  }
  r['eventTypes'] = {
    async listForUser(userId: string) {
      return eventTypes.filter((e) => e.ownerUserId === userId)
    },
  }

  const provider = {
    name: 'google',
    async getBusy(c: CalendarConnection, range: Interval) {
      getBusyCalls.push(c.userId)
      const b = busy.get(c.userId) ?? []
      if (b instanceof Error) throw b
      return b.filter((i) => i.start < range.end && i.end > range.start)
    },
  } as unknown as CalendarProvider

  const svc = createInternalService({
    ports: {
      repositories: () => repos,
      calendars: { get: () => provider, available: () => ['google'] },
      clock: { now: () => NOW },
      config: fakeConfig({ baseUrl: 'https://cal.swayq.com/' }),
    },
    providerDeps: {
      oauth: createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }, 'https://cal.swayq.com'),
      crypto: { decrypt: async () => JSON.stringify(VALID_TOKENS), randomToken: (n = 16) => 'r'.repeat(n) },
      clock: { now: () => NOW },
      sleep: async () => {},
      onTokensRefreshed: async () => {},
      fetch: google.fetchImpl,
    },
    serviceToken: 'serviceToken' in opts ? opts.serviceToken : TOKEN,
    allowedDomains: opts.allowedDomains ?? [],
    logError: () => {},
  })

  return { repos, svc, google, busy, getBusyCalls, eventTypes }
}

const at = (iso: string) => Date.parse(iso)

function createInput(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    actingUserEmail: JH,
    attendeeEmails: [PETER, EMMA],
    start: '2026-10-20T10:00:00+02:00',
    end: '2026-10-20T10:30:00+02:00',
    timezone: TZ,
    title: 'Campaign sync',
    description: 'Agenda in the doc',
    idempotencyKey: 'mcp-req-0001',
    ...over,
  }
}

function findInput(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    actingUserEmail: JH,
    attendeeEmails: [PETER, EMMA],
    durationMinutes: 30,
    windowStart: '2026-10-19T00:00:00+02:00',
    windowEnd: '2026-10-24T00:00:00+02:00',
    timezone: TZ,
    ...over,
  }
}

function expectError(res: unknown, code: string): InternalError {
  expect(res).toMatchObject({ ok: false, code })
  return res as InternalError
}

// ---------------------------------------------------------------------------

describe('service token', () => {
  it('refuses a wrong token', async () => {
    const h = harness()
    expectError(await h.svc.findTime(findInput({ token: 'nope' })), 'UNAUTHORIZED')
  })

  it('refuses a missing token, and a non-object input, before validating anything', async () => {
    const h = harness()
    const { token: _t, ...rest } = findInput()
    expectError(await h.svc.findTime(rest), 'UNAUTHORIZED')
    expectError(await h.svc.findTime(null), 'UNAUTHORIZED')
    expectError(await h.svc.findTime('garbage'), 'UNAUTHORIZED')
  })

  it('refuses EVERY method when the secret is unset or blank', async () => {
    for (const serviceToken of [undefined, '', '   ']) {
      const h = harness({ serviceToken })
      for (const res of [
        await h.svc.findTime(findInput()),
        await h.svc.createMeeting(createInput()),
        await h.svc.listMyMeetings({ token: TOKEN, actingUserEmail: JH, from: '2026-10-19T00:00:00Z', to: '2026-10-26T00:00:00Z' }),
        await h.svc.rescheduleMeeting({ token: TOKEN, actingUserEmail: JH, eventId: 'abcde', start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:00:00Z' }),
        await h.svc.cancelMeeting({ token: TOKEN, actingUserEmail: JH, eventId: 'abcde' }),
        await h.svc.myBookingLinks({ token: TOKEN, actingUserEmail: JH }),
      ]) {
        expectError(res, 'SERVICE_NOT_CONFIGURED')
      }
      expect(h.google.calls).toHaveLength(0)
      expect(h.getBusyCalls).toHaveLength(0)
    }
  })
})

describe('acting user', () => {
  it('refuses an unknown actor', async () => {
    const h = harness()
    expectError(await h.svc.findTime(findInput({ actingUserEmail: 'stranger@swayq.com' })), 'UNKNOWN_ACTOR')
    expectError(await h.svc.createMeeting(createInput({ actingUserEmail: 'stranger@swayq.com' })), 'UNKNOWN_ACTOR')
    expect(h.google.calls).toHaveLength(0)
  })

  it('refuses a removed (deactivated) user', async () => {
    const h = harness()
    h.repos.state.users.delete('u_jh')
    expectError(await h.svc.myBookingLinks({ token: TOKEN, actingUserEmail: JH }), 'UNKNOWN_ACTOR')
  })

  it('normalizes case and whitespace on the actor', async () => {
    const h = harness()
    const res = await h.svc.myBookingLinks({ token: TOKEN, actingUserEmail: '  JH@SwayQ.com ' })
    expect(res.ok).toBe(true)
  })

  it('refuses an actor outside INTERNAL_ALLOWED_DOMAINS even when they are a user', async () => {
    const h = harness({ allowedDomains: ['swayq.com'] })
    h.repos.seedUser({ id: 'u_out', email: 'someone@gmail.com' })
    expectError(await h.svc.myBookingLinks({ token: TOKEN, actingUserEmail: 'someone@gmail.com' }), 'UNKNOWN_ACTOR')
  })
})

describe('attendee guard: every attendee must be an active Punctual user', () => {
  it('refuses a single external attendee, sending nothing', async () => {
    const h = harness()
    const res = expectError(
      await h.svc.createMeeting(createInput({ attendeeEmails: ['client@brand.dk'] })),
      'EXTERNAL_ATTENDEE',
    )
    expect(res.externalEmails).toEqual(['client@brand.dk'])
    expect(h.google.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    expect(h.getBusyCalls).toHaveLength(0)
  })

  it('refuses a mixed internal + external list as a WHOLE, naming every outsider', async () => {
    const h = harness()
    const res = expectError(
      await h.svc.createMeeting(createInput({ attendeeEmails: [PETER, 'a@brand.dk', EMMA, ' B@Other.com '] })),
      'EXTERNAL_ATTENDEE',
    )
    expect(res.externalEmails).toEqual(['a@brand.dk', 'b@other.com'])
    expect(h.google.calls).toHaveLength(0)
    // findTime is guarded the same way: no calendar is read for anyone.
    expectError(await h.svc.findTime(findInput({ attendeeEmails: [PETER, 'a@brand.dk'] })), 'EXTERNAL_ATTENDEE')
    expect(h.getBusyCalls).toHaveLength(0)
  })

  it('normalizes case/whitespace and collapses duplicates before deciding', async () => {
    const h = harness()
    const res = await h.svc.createMeeting(
      createInput({ attendeeEmails: [' Peter@SwayQ.com', 'peter@swayq.com', 'EMMA@swayq.com ', 'JH@swayq.com'] }),
    )
    expect(res.ok).toBe(true)
    const insert = h.google.calls.find((c) => c.method === 'POST')!
    expect((insert.body as StoredEvent).attendees.map((a) => a.email)).toEqual([JH, PETER, EMMA])
  })

  it('refuses more than 20 attendees', async () => {
    const h = harness()
    const many = Array.from({ length: 21 }, (_, i) => `staff${i}@swayq.com`)
    for (const [i, e] of many.entries()) h.repos.seedUser({ id: `u_s${i}`, email: e })
    expectError(await h.svc.createMeeting(createInput({ attendeeEmails: many })), 'TOO_MANY_ATTENDEES')
  })

  it('applies INTERNAL_ALLOWED_DOMAINS to attendees too', async () => {
    const h = harness({ allowedDomains: ['swayq.com'] })
    h.repos.seedUser({ id: 'u_gm', email: 'friend@gmail.com' })
    const res = expectError(
      await h.svc.createMeeting(createInput({ attendeeEmails: [PETER, 'friend@gmail.com'] })),
      'EXTERNAL_ATTENDEE',
    )
    expect(res.externalEmails).toEqual(['friend@gmail.com'])
  })
})

describe('findTime', () => {
  it('returns candidate slots inside everyone working hours, avoiding busy time', async () => {
    const h = harness()
    // Peter busy Monday 09:00-12:00 Copenhagen.
    h.busy.set('u_peter', [{ start: at('2026-10-19T07:00:00Z'), end: at('2026-10-19T10:00:00Z') }])
    const res = await h.svc.findTime(findInput())
    if (!res.ok) throw new Error(res.code)
    expect(res.slots.length).toBe(10)
    for (const s of res.slots) {
      const start = Date.parse(s.start)
      expect(start).toBeGreaterThan(NOW)
      // Not inside Peter's busy block.
      expect(start >= at('2026-10-19T10:00:00Z') || start < at('2026-10-19T07:00:00Z')).toBe(true)
      // Inside 09:00-17:00 Copenhagen (UTC+2 in October).
      const hour = new Date(start).getUTCHours() + 2
      expect(hour).toBeGreaterThanOrEqual(9)
      expect(hour).toBeLessThan(17)
      expect(s.label).toMatch(/\d/)
    }
    // Spread: no more than 3 on the first day.
    const monday = res.slots.filter((s) => s.start.startsWith('2026-10-19'))
    expect(monday.length).toBeLessThanOrEqual(3)
    // Fresh reads for all three participants.
    expect(new Set(h.getBusyCalls)).toEqual(new Set(['u_jh', 'u_peter', 'u_emma']))
  })

  it('returns busy BLOCKS only, never titles or other event data', async () => {
    const h = harness()
    h.busy.set('u_emma', [{ start: at('2026-10-20T08:00:00Z'), end: at('2026-10-20T09:00:00Z') }])
    const res = await h.svc.findTime(findInput())
    if (!res.ok) throw new Error(res.code)
    const emma = res.busy.find((b) => b.email === EMMA)!
    expect(emma.blocks).toEqual([{ start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T09:00:00.000Z' }])
    for (const b of res.busy) for (const block of b.blocks) expect(Object.keys(block).sort()).toEqual(['end', 'start'])
  })

  it('fails CLOSED when one attendee calendar errors, naming only that email', async () => {
    const h = harness()
    h.busy.set('u_emma', new CalendarApiError('google', 'freeBusy failed', { status: 500, body: 'secret body' }))
    const res = expectError(await h.svc.findTime(findInput()), 'CALENDAR_UNAVAILABLE')
    expect(res.unavailableEmails).toEqual([EMMA])
    expect(JSON.stringify(res)).not.toContain('secret body')
  })

  it('fails closed when an attendee has no readable calendar or needs reconnect', async () => {
    const h = harness()
    h.repos.state.connections.delete('conn_u_peter')
    void h.repos.connections.create(conn('u_emma', EMMA, { syncStatus: 'needs_reconnect' }))
    const res = expectError(await h.svc.findTime(findInput()), 'CALENDAR_UNAVAILABLE')
    expect(res.unavailableEmails?.sort()).toEqual([EMMA, PETER])
  })

  it('ignores working hours when asked', async () => {
    const h = harness()
    const res = await h.svc.findTime(
      findInput({
        workingHoursOnly: false,
        windowStart: '2026-10-24T00:00:00+02:00', // Saturday
        windowEnd: '2026-10-25T00:00:00+02:00',
      }),
    )
    if (!res.ok) throw new Error(res.code)
    expect(res.slots.length).toBeGreaterThan(0)
  })

  it('validates input', async () => {
    const h = harness()
    const res = expectError(await h.svc.findTime(findInput({ durationMinutes: 7, timezone: 'Mars/Base' })), 'INVALID_INPUT')
    expect(res.issues?.map((i) => i.path).sort()).toEqual(['durationMinutes', 'timezone'])
  })
})

describe('createMeeting', () => {
  it('creates on the organizer write calendar with Meet, sendUpdates=all and the private marker', async () => {
    const h = harness()
    const res = await h.svc.createMeeting(createInput())
    if (!res.ok) throw new Error(res.code)
    expect(res).toMatchObject({
      created: true,
      start: '2026-10-20T08:00:00.000Z',
      end: '2026-10-20T08:30:00.000Z',
      timezone: TZ,
      attendees: [JH, PETER, EMMA],
    })
    expect(res.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//)
    const insert = h.google.calls.find((c) => c.method === 'POST')!
    expect(insert.url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(JH)}/events`)
    expect(insert.url.searchParams.get('sendUpdates')).toBe('all')
    expect(insert.url.searchParams.get('conferenceDataVersion')).toBe('1')
    const body = insert.body as Record<string, any>
    expect(body.extendedProperties.private).toEqual({ swayqInternalMeeting: '1', swayqOrganizer: JH })
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
    expect(body.id).toMatch(/^[a-v0-9]{5,1024}$/)
  })

  it('re-checks freeBusy inside the call and refuses a slot that became busy', async () => {
    const h = harness()
    h.busy.set('u_peter', [{ start: at('2026-10-20T08:15:00Z'), end: at('2026-10-20T09:00:00Z') }])
    const res = expectError(await h.svc.createMeeting(createInput()), 'SLOT_BUSY')
    expect(res.busyEmails).toEqual([PETER])
    expect(h.google.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('fails closed when a calendar cannot be read at create time', async () => {
    const h = harness()
    h.busy.set('u_peter', new Error('boom'))
    expectError(await h.svc.createMeeting(createInput()), 'CALENDAR_UNAVAILABLE')
    expect(h.google.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('an idempotent retry returns the same event, even though everyone is now busy at that slot', async () => {
    const h = harness()
    const first = await h.svc.createMeeting(createInput())
    if (!first.ok) throw new Error(first.code)
    // The first attempt's own event now shows on every calendar.
    for (const u of ['u_jh', 'u_peter', 'u_emma']) {
      h.busy.set(u, [{ start: at('2026-10-20T08:00:00Z'), end: at('2026-10-20T08:30:00Z') }])
    }
    const again = await h.svc.createMeeting(createInput())
    if (!again.ok) throw new Error(again.code)
    expect(again.eventId).toBe(first.eventId)
    expect(again.created).toBe(false)
    expect(h.google.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('a create that races an earlier attempt reads the event back on 409', async () => {
    const h = harness()
    const first = await h.svc.createMeeting(createInput())
    if (!first.ok) throw new Error(first.code)
    // Make the pre-check GET miss once, as if the earlier attempt landed between it and the insert.
    const original = h.google.fetchImpl
    let missed = false
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!missed && (init?.method ?? 'GET') === 'GET') {
        missed = true
        return new Response('{}', { status: 404 })
      }
      return original(input, init)
    }) as typeof fetch
    // Same Google state (h's store), a fresh service whose first GET misses.
    const svc = createInternalService({
      ports: {
        repositories: () => h.repos,
        calendars: { get: () => ({ name: 'google', getBusy: async () => [] }) as never, available: () => ['google'] },
        clock: { now: () => NOW },
        config: fakeConfig(),
      },
      providerDeps: {
        oauth: createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }, 'https://x'),
        crypto: { decrypt: async () => JSON.stringify(VALID_TOKENS), randomToken: () => 'r' },
        clock: { now: () => NOW },
        sleep: async () => {},
        onTokensRefreshed: async () => {},
        fetch: racing,
      },
      serviceToken: TOKEN,
      logError: () => {},
    })
    const res = await svc.createMeeting(createInput())
    if (!res.ok) throw new Error(res.code)
    expect(res.eventId).toBe(first.eventId)
    expect(res.created).toBe(false)
    expect(h.google.calls.filter((c) => c.method === 'POST').map((c) => c.url.pathname)).toHaveLength(2)
  })

  it('refuses reusing an idempotency key for a different time', async () => {
    const h = harness()
    await h.svc.createMeeting(createInput())
    expectError(
      await h.svc.createMeeting(createInput({ start: '2026-10-20T11:00:00+02:00', end: '2026-10-20T11:30:00+02:00' })),
      'IDEMPOTENCY_CONFLICT',
    )
  })

  it('refuses a start in the past', async () => {
    const h = harness()
    expectError(
      await h.svc.createMeeting(createInput({ start: '2026-10-18T10:00:00+02:00', end: '2026-10-18T10:30:00+02:00' })),
      'INVALID_INPUT',
    )
  })

  it('needs a Google write calendar', async () => {
    const h = harness()
    h.repos.state.connections.set('conn_u_jh', conn('u_jh', JH, { calendarIdWrite: null }))
    expectError(await h.svc.createMeeting(createInput()), 'NO_WRITE_CALENDAR')
    h.repos.state.connections.set('conn_u_jh', conn('u_jh', JH, { provider: 'microsoft' }))
    expectError(await h.svc.createMeeting(createInput()), 'UNSUPPORTED_PROVIDER')
  })

  it('never leaks a provider body when Google fails the insert', async () => {
    const h = harness()
    const svc = createInternalService({
      ports: {
        repositories: () => h.repos,
        calendars: { get: () => ({ name: 'google', getBusy: async () => [] }) as never, available: () => ['google'] },
        clock: { now: () => NOW },
        config: fakeConfig(),
      },
      providerDeps: {
        oauth: createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }, 'https://x'),
        crypto: { decrypt: async () => JSON.stringify(VALID_TOKENS), randomToken: () => 'r' },
        clock: { now: () => NOW },
        sleep: async () => {},
        onTokensRefreshed: async () => {},
        fetch: (async (_i: RequestInfo | URL, init?: RequestInit) =>
          (init?.method ?? 'GET') === 'GET'
            ? new Response('{}', { status: 404 })
            : new Response('{"error":"ya29.LEAKED-TOKEN internal detail"}', { status: 500 })) as typeof fetch,
      },
      serviceToken: TOKEN,
      logError: () => {},
    })
    const res = expectError(await svc.createMeeting(createInput()), 'PROVIDER_ERROR')
    expect(JSON.stringify(res)).not.toContain('LEAKED')
  })
})

describe('listMyMeetings', () => {
  it('lists only marked meetings the actor organized', async () => {
    const h = harness()
    const created = await h.svc.createMeeting(createInput())
    if (!created.ok) throw new Error(created.code)
    // An unmarked personal event on the same calendar.
    h.google.cal(JH).set('personal1', {
      id: 'personal1',
      status: 'confirmed',
      summary: 'Dentist',
      start: { dateTime: '2026-10-21T08:00:00Z' },
      end: { dateTime: '2026-10-21T09:00:00Z' },
      attendees: [],
      htmlLink: 'x',
    })
    const res = await h.svc.listMyMeetings({
      token: TOKEN,
      actingUserEmail: JH,
      from: '2026-10-19T00:00:00Z',
      to: '2026-10-26T00:00:00Z',
    })
    if (!res.ok) throw new Error(res.code)
    expect(res.meetings.map((m) => m.eventId)).toEqual([created.eventId])
    const list = h.google.calls.find((c) => c.method === 'GET' && c.url.pathname.endsWith('/events'))!
    expect(list.url.searchParams.get('privateExtendedProperty')).toBe('swayqInternalMeeting=1')
  })
})

describe('ownership guard: reschedule and cancel', () => {
  function seedEvent(h: Harness, calendarId: string, id: string, priv?: Record<string, string>) {
    h.google.cal(calendarId).set(id, {
      id,
      status: 'confirmed',
      summary: 'Someone else meeting',
      start: { dateTime: '2026-10-21T08:00:00Z' },
      end: { dateTime: '2026-10-21T08:30:00Z' },
      attendees: [{ email: JH }, { email: PETER }],
      ...(priv ? { extendedProperties: { private: priv } } : {}),
      htmlLink: 'x',
    })
  }
  const move = (eventId: string) => ({
    token: TOKEN,
    actingUserEmail: JH,
    eventId,
    start: '2026-10-21T13:00:00+02:00',
    end: '2026-10-21T13:30:00+02:00',
  })

  it('refuses an event without the internal marker', async () => {
    const h = harness()
    seedEvent(h, JH, 'nomarker1')
    expectError(await h.svc.rescheduleMeeting(move('nomarker1')), 'NOT_OWNER')
    expectError(await h.svc.cancelMeeting({ token: TOKEN, actingUserEmail: JH, eventId: 'nomarker1' }), 'NOT_OWNER')
    expect(h.google.calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE')).toHaveLength(0)
  })

  it('refuses an event whose swayqOrganizer is someone else', async () => {
    const h = harness()
    seedEvent(h, JH, 'othermark1', { swayqInternalMeeting: '1', swayqOrganizer: PETER })
    expectError(await h.svc.rescheduleMeeting(move('othermark1')), 'NOT_OWNER')
    expectError(await h.svc.cancelMeeting({ token: TOKEN, actingUserEmail: JH, eventId: 'othermark1' }), 'NOT_OWNER')
    expect(h.google.calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE')).toHaveLength(0)
  })

  it("cannot reach an event on another user's calendar", async () => {
    const h = harness()
    // Peter's own internal meeting lives on Peter's calendar only.
    seedEvent(h, PETER, 'peterevt1', { swayqInternalMeeting: '1', swayqOrganizer: PETER })
    expectError(await h.svc.rescheduleMeeting(move('peterevt1')), 'NOT_FOUND')
    const cancel = await h.svc.cancelMeeting({ token: TOKEN, actingUserEmail: JH, eventId: 'peterevt1' })
    expect(cancel).toEqual({ ok: true, eventId: 'peterevt1', cancelled: false })
    expect(h.google.cal(PETER).has('peterevt1')).toBe(true)
    // Every call went to the ACTOR's calendar.
    for (const c of h.google.calls) expect(c.url.pathname).toContain(encodeURIComponent(JH))
  })

  it('reschedules an owned meeting with sendUpdates=all, keeping the conference', async () => {
    const h = harness()
    const created = await h.svc.createMeeting(createInput())
    if (!created.ok) throw new Error(created.code)
    // Everyone is "busy" at the meeting's own current slot.
    for (const u of ['u_jh', 'u_peter', 'u_emma']) {
      h.busy.set(u, [{ start: at('2026-10-20T08:00:00Z'), end: at('2026-10-20T08:30:00Z') }])
    }
    const res = await h.svc.rescheduleMeeting({
      token: TOKEN,
      actingUserEmail: JH,
      eventId: created.eventId,
      start: '2026-10-20T10:15:00+02:00',
      end: '2026-10-20T10:45:00+02:00',
    })
    if (!res.ok) throw new Error(res.code)
    expect(res.start).toBe('2026-10-20T08:15:00.000Z')
    const patch = h.google.calls.find((c) => c.method === 'PATCH')!
    expect(patch.url.searchParams.get('sendUpdates')).toBe('all')
    expect(patch.body).not.toHaveProperty('conferenceData')
    expect(res.meetUrl).toBe(created.meetUrl)
  })

  it('reschedule refuses a busy target slot', async () => {
    const h = harness()
    const created = await h.svc.createMeeting(createInput())
    if (!created.ok) throw new Error(created.code)
    h.busy.set('u_emma', [{ start: at('2026-10-21T11:00:00Z'), end: at('2026-10-21T12:00:00Z') }])
    const res = expectError(
      await h.svc.rescheduleMeeting({ ...move(created.eventId) }),
      'SLOT_BUSY',
    )
    expect(res.busyEmails).toEqual([EMMA])
  })

  it('reschedule refuses when someone added an external guest to the event by hand', async () => {
    const h = harness()
    const created = await h.svc.createMeeting(createInput())
    if (!created.ok) throw new Error(created.code)
    h.google.cal(JH).get(created.eventId)!.attendees.push({ email: 'client@brand.dk' })
    const res = expectError(await h.svc.rescheduleMeeting(move(created.eventId)), 'EXTERNAL_ATTENDEE')
    expect(res.externalEmails).toEqual(['client@brand.dk'])
    expect(h.google.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })

  it('cancels an owned meeting with sendUpdates=all, idempotently', async () => {
    const h = harness()
    const created = await h.svc.createMeeting(createInput())
    if (!created.ok) throw new Error(created.code)
    const input = { token: TOKEN, actingUserEmail: JH, eventId: created.eventId }
    expect(await h.svc.cancelMeeting(input)).toEqual({ ok: true, eventId: created.eventId, cancelled: true })
    const del = h.google.calls.find((c) => c.method === 'DELETE')!
    expect(del.url.searchParams.get('sendUpdates')).toBe('all')
    expect(await h.svc.cancelMeeting(input)).toEqual({ ok: true, eventId: created.eventId, cancelled: false })
  })
})

describe('myBookingLinks', () => {
  it("returns the actor's active personal event types as absolute URLs", async () => {
    const h = harness()
    const et = (over: Partial<EventType>): EventType =>
      ({
        id: 'et',
        ownerUserId: 'u_jh',
        ownerTeamId: null,
        schedulingType: 'personal',
        slug: 'intro',
        title: 'Intro call',
        description: '',
        durationMinutes: 30,
        active: true,
        ...over,
      }) as EventType
    h.eventTypes.push(et({}), et({ id: 'et2', slug: 'off', active: false }), et({ id: 'et3', ownerUserId: 'u_peter', slug: 'p' }))
    const res = await h.svc.myBookingLinks({ token: TOKEN, actingUserEmail: JH })
    expect(res).toEqual({
      ok: true,
      links: [{ title: 'Intro call', slug: 'intro', durationMinutes: 30, url: 'https://cal.swayq.com/jh/intro' }],
    })
  })
})
