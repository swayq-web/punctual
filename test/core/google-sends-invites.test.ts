import { describe, expect, it } from 'vitest'
import { createGoogleProvider } from '../../src/adapters/google/provider.js'
import { createEnvOAuthCredentials } from '../../src/adapters/oauth.js'
import { notifyBookingCancelled, notifyBookingCreated, notifyBookingRescheduled } from '../../src/adapters/notify.js'
import type { Booking, CalendarConnection, EventType, OAuthTokens, User } from '../../src/core/domain/types.js'
import type { EnginePorts, QueueMessage } from '../../src/ports.js'

/**
 * SWA-1287: Google sends the guest's invitation, updates and cancellation
 * (sendUpdates=all), so punctual's own mail must not also attach an .ics for a
 * Google-hosted booking. Non-Google bookings keep the .ics.
 */

const TOKENS: OAuthTokens = { accessToken: 'ya29', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, scope: 's' }

function scriptGoogle(routes: Array<[RegExp, { status?: number; json: unknown }]>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    for (const [re, r] of routes) {
      if (re.test(url)) return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 501 })
  }) as typeof globalThis.fetch
  return { fetchImpl, calls }
}

function provider(fetchImpl: typeof globalThis.fetch) {
  return createGoogleProvider({
    oauth: createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' }, 'https://punctual.sh'),
    crypto: { decrypt: async () => JSON.stringify(TOKENS), randomToken: (n = 16) => 'r'.repeat(n) },
    clock: { now: () => Date.now() },
    sleep: async () => {},
    onTokensRefreshed: async () => {},
    fetch: fetchImpl,
  } as never)
}

function conn(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn_g', userId: 'u_host', provider: 'google', providerAccountEmail: 'grace@example.com',
    encryptedTokens: 'x', keyVersion: 1, calendarIdsRead: ['primary'], calendarIdWrite: 'primary',
    syncStatus: 'ok', createdAt: 0, ...over,
  }
}

const START = Date.UTC(2026, 8, 14, 9)
const event = {
  title: 'Intro', description: 'd', start: START, end: START + 30 * 60_000, timezone: 'UTC',
  attendees: [{ email: 'ada@example.com', name: 'Ada' }, { email: 'grace@example.com', name: 'Grace' }, { email: 'extra@example.com' }],
}

describe('Google adapter sends the invitations', () => {
  it('insert, patch and delete all use sendUpdates=all', async () => {
    const { fetchImpl, calls } = scriptGoogle([[/\/events/, { json: { id: 'evt_1', hangoutLink: 'https://meet.google.com/a' } }]])
    const p = provider(fetchImpl)
    await p.createEvent(conn(), { ...event, createConference: true })
    await p.updateEvent(conn(), 'evt_1', event)
    await p.deleteEvent(conn(), 'evt_1')
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'DELETE'])
    for (const c of calls) {
      expect(new URL(c.url).searchParams.get('sendUpdates')).toBe('all')
    }
  })

  it('update and delete target the calendar the event was written to, not the current write calendar', async () => {
    const { fetchImpl, calls } = scriptGoogle([[/\/events/, { json: { id: 'evt_1' } }]])
    const p = provider(fetchImpl)
    const switched = conn({ calendarIdWrite: 'new-cal' })
    await p.updateEvent(switched, 'evt_1', event, 'old-cal')
    await p.deleteEvent(switched, 'evt_1', 'old-cal')
    await p.deleteEvent(switched, 'evt_2')
    expect(calls[0]!.url).toContain('/calendars/old-cal/events/evt_1')
    expect(calls[1]!.url).toContain('/calendars/old-cal/events/evt_1')
    expect(calls[2]!.url).toContain('/calendars/new-cal/events/evt_2')
  })

  it('insert carries guest and extra attendees; reschedule PATCH carries no createRequest', async () => {
    const { fetchImpl, calls } = scriptGoogle([[/\/events/, { json: { id: 'evt_1', hangoutLink: 'https://meet.google.com/a' } }]])
    const p = provider(fetchImpl)
    await p.createEvent(conn(), { ...event, createConference: true })
    await p.updateEvent(conn(), 'evt_1', event)
    const insert = calls[0]!.body as { attendees: Array<{ email: string }> }
    expect(insert.attendees.map((a) => a.email)).toEqual(['ada@example.com', 'grace@example.com', 'extra@example.com'])
    const patch = calls[1]!.body as Record<string, unknown>
    expect(patch).not.toHaveProperty('conferenceData')
    expect(new URL(calls[1]!.url).searchParams.get('conferenceDataVersion')).toBe('1')
  })

  it('the 409 read-back path still returns the existing event', async () => {
    const { fetchImpl, calls } = scriptGoogle([
      [/\/events\/pu[a-v0-9]+/, { json: { id: 'x', hangoutLink: 'https://meet.google.com/abc' } }],
      [/\/events\?/, { status: 409, json: { error: { code: 409 } } }],
    ])
    const created = await provider(fetchImpl).createEvent(conn(), { ...event, idempotencyKey: 'bk:c' })
    expect(created.conferenceUrl).toBe('https://meet.google.com/abc')
    expect(new URL(calls[0]!.url).searchParams.get('sendUpdates')).toBe('all')
  })
})

const host: User = {
  id: 'u_host', email: 'grace@example.com', name: 'Grace Hopper', tz: 'UTC', slug: 'grace', avatarKey: null,
  company: null, jobTitle: null, companyUrl: null, role: 'member', createdAt: 0,
}
const et = {
  id: 'et_1', ownerUserId: 'u_host', ownerTeamId: null, schedulingType: 'personal', slug: 'intro', title: 'Intro',
  description: 'd', durationMinutes: 30, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  minNoticeMinutes: 60, maxHorizonDays: 60, maxPerDay: null, locationType: 'google_meet', locationValue: null,
  questions: [], active: true, createdAt: 0, scheduleId: null,
} as unknown as EventType

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1', eventTypeId: 'et_1', hostUserId: 'u_host', hostUserIds: ['u_host'], guestName: 'Ada',
    guestEmail: 'ada@example.com', guestTimezone: 'UTC', startUtc: START, endUtc: START + 30 * 60_000,
    localDate: '2026-09-14', status: 'confirmed', answers: {}, externalEventIds: {}, conferenceUrl: null,
    rescheduleOf: null, rescheduledTo: null, manageTokenHash: 'h', cancelledAt: null, createdAt: 0, ...patch,
  }
}

function ports(sent: QueueMessage[], conns: CalendarConnection[]): EnginePorts {
  return {
    repositories: () => ({
      webhooks: { listForUser: async () => [] },
      bookings: { byId: async () => null, listByIds: async () => [] },
      connections: {
        byId: async (id: string) => conns.find((c) => c.id === id) ?? null,
        listForUser: async () => conns,
      },
      users: { byId: async () => host },
      teams: { byId: async () => null },
      schedules: { byId: async () => null },
      settings: { get: async () => null },
    }),
    queue: { send: async (m: QueueMessage) => { sent.push(m) }, sendBatch: async (m: QueueMessage[]) => { sent.push(...m) } },
    config: { baseUrl: 'https://p.example', brandName: 'P', supportEmail: 's@p.example', fromEmail: 'n@p.example', fromName: 'P', telemetryEnabled: false },
  } as unknown as EnginePorts
}

const atts = (sent: QueueMessage[]) =>
  sent.filter((m): m is Extract<QueueMessage, { kind: 'email' }> => m.kind === 'email').map((m) => m.message.attachments)

describe('punctual attaches no .ics iff the stored invite channel is google', () => {
  const google = (patch: Partial<Booking> = {}) => booking({ inviteChannel: 'google', externalEventIds: { conn_g: 'evt_1' }, ...patch })

  it('confirmation: google channel has no attachment; ics and null channel keep the .ics', async () => {
    const g: QueueMessage[] = []
    await notifyBookingCreated({ ports: ports(g, [conn()]), booking: google(), eventType: et, host, manageToken: 't' })
    expect(atts(g).length).toBe(2)
    for (const a of atts(g)) expect(a).toBeUndefined()

    for (const channel of ['ics', null] as const) {
      const sent: QueueMessage[] = []
      await notifyBookingCreated({ ports: ports(sent, []), booking: booking({ inviteChannel: channel }), eventType: et, host, manageToken: 't' })
      expect(atts(sent).length).toBe(2)
      for (const a of atts(sent)) expect(a?.[0]?.filename).toBe('invite.ics')
    }
  })

  it('reschedule: .ics suppressed only when BOTH original and replacement are google', async () => {
    const run = async (prevCh: 'google' | 'ics' | null, newCh: 'google' | 'ics' | null) => {
      const sent: QueueMessage[] = []
      await notifyBookingRescheduled({
        ports: ports(sent, [conn()]),
        booking: booking({ id: 'bk_1', rescheduleOf: 'bk_0', inviteChannel: newCh }),
        previous: booking({ id: 'bk_0', inviteChannel: prevCh }),
        eventType: et, host, manageToken: 't',
      })
      return atts(sent)
    }
    for (const a of await run('google', 'google')) expect(a).toBeUndefined()
    for (const [p, n] of [['ics', 'google'], ['google', 'ics'], [null, 'google'], ['ics', 'ics']] as const) {
      for (const a of await run(p, n)) expect(a?.[0]?.filename).toBe('invite.ics')
    }
  })

  it('cancel: a never-synced booking (null/ics channel) still gets the CANCEL .ics, even with a healthy Google connection', async () => {
    for (const channel of [null, 'ics'] as const) {
      const sent: QueueMessage[] = []
      await notifyBookingCancelled({ ports: ports(sent, [conn()]), booking: booking({ inviteChannel: channel }), eventType: et, host, cancelledBy: 'guest' })
      expect(atts(sent).length).toBe(2)
      for (const a of atts(sent)) expect(a?.[0]?.filename).toBe('invite.ics')
    }
  })

  it('cancel: a google-channel booking gets no .ics, whatever the stored ids are', async () => {
    const sent: QueueMessage[] = []
    await notifyBookingCancelled({ ports: ports(sent, [conn()]), booking: google({ externalEventIds: {} }), eventType: et, host, cancelledBy: 'guest' })
    expect(atts(sent).length).toBe(2)
    for (const a of atts(sent)) expect(a).toBeUndefined()
  })
})
