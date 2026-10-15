/**
 * Fail CLOSED on an unreadable calendar (SWA-1285).
 *
 * A host whose external calendar cannot be read is never treated as free:
 * not at listing time, not at commit time. An outage must never produce a
 * double booking. These run under the real Workers runtime with the real
 * D1, the real KV cache and the real host Durable Object coordinator; only
 * the calendar provider is a fake, because its failure is the input.
 */

import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { buildPorts, type Env } from '../../src/index.js'
import { createSlotService } from '../../src/engine.js'
import { buildRouter } from '../../src/http/router.js'
import { buildApiRoutes } from '../../src/http/api/rest.js'
import { createApiKey } from '../../src/core/domain/auth-flows.js'
import { parseGoogleFreeBusy } from '../../src/adapters/google/provider.js'
import { CalendarReconnectRequiredError } from '../../src/adapters/oauth.js'
import { saveCalendarConnection } from '../../src/http/calendar-connect.js'
import type { CalendarProvider, EnginePorts } from '../../src/ports.js'
import type { CalendarConnection, EventType, User } from '../../src/core/domain/types.js'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

// ---- The fake provider: its failure mode is the input under test ---------

type Mode = 'ok' | 'busy' | 'outage' | 'freebusy_error' | 'revoked' | 'no_calendars_key'
const modes = new Map<string, Mode>()

const provider: CalendarProvider = {
  name: 'google',
  async getBusy(conn) {
    const mode = modes.get(conn.id) ?? 'ok'
    if (mode === 'outage') throw new Error('google freeBusy 503 Service Unavailable')
    if (mode === 'revoked') throw new CalendarReconnectRequiredError('google', conn.id, 'invalid_grant')
    if (mode === 'busy') return [{ start: START, end: END }]
    if (mode === 'no_calendars_key') {
      // A 200 whose body has no `calendars` at all: unparseable, not free.
      return parseGoogleFreeBusy({ kind: 'calendar#freeBusy' })
    }
    if (mode === 'freebusy_error') {
      // A 200 response whose calendar entry carries errors: the REAL parser
      // throws on it, which is what the commit path must not swallow.
      return parseGoogleFreeBusy({
        kind: 'calendar#freeBusy',
        calendars: { primary: { errors: [{ domain: 'global', reason: 'backendError' }], busy: [] } },
      })
    }
    return []
  },
  async createEvent() {
    return { id: 'ext_1' }
  },
  async updateEvent() {},
  async deleteEvent() {},
  async listCalendars() {
    return []
  },
}

function testPorts(): EnginePorts {
  const ports = buildPorts({
    ...env,
    BASE_URL: 'https://punctual.test',
    ENCRYPTION_KEY_V1: keyMaterial(1),
    SIGNING_KEY: keyMaterial(9),
  } as Env)
  // The coordinator holds this same object, so replacing the registry here
  // reaches the commit path too.
  ;(ports as { calendars: EnginePorts['calendars'] }).calendars = {
    get: () => provider,
    available: () => ['google'],
  }
  return ports
}

// ---- Seeding -------------------------------------------------------------

let n = 0
const DAY = 86_400_000
const allDay = [{ startMinute: 0, endMinute: 24 * 60 }]

/** Seven days out, 10:00 UTC, bucket aligned. All-day schedules make any day bookable. */
const START = (() => {
  const d = new Date(Date.now() + 7 * DAY)
  d.setUTCHours(10, 0, 0, 0)
  return d.getTime()
})()
const END = START + 30 * 60_000

async function seedUser(ports: EnginePorts, label: string): Promise<User> {
  const i = ++n
  const repos = ports.repositories({ consistency: 'bookmark' })
  const user = await repos.users.create({
    id: `usr_fc_${label}_${i}`,
    email: `${label}${i}@punctual.test`,
    name: `Host ${label}`,
    tz: 'UTC',
    slug: `fc-${label}-${i}`,
    avatarKey: null,
    company: null,
    jobTitle: null,
    companyUrl: null,
    role: 'member',
  })
  if (!user) throw new Error('seedUser collided')
  await repos.availability.create(user.id, {
    id: `sch_fc_${i}`,
    userId: user.id,
    name: 'Always',
    isDefault: true,
    timezone: 'UTC',
    weekly: [allDay, allDay, allDay, allDay, allDay, allDay, allDay],
    overrides: [],
  })
  return user
}

/** A read connection whose getBusy follows `modes`. */
async function connect(
  ports: EnginePorts,
  user: User,
  mode: Mode = 'ok',
  calendarIdsRead: string[] = ['primary'],
): Promise<CalendarConnection> {
  const conn: CalendarConnection = {
    id: `conn_fc_${++n}`,
    userId: user.id,
    provider: 'google',
    providerAccountEmail: user.email,
    encryptedTokens: 'unused-by-the-fake',
    keyVersion: 1,
    calendarIdsRead,
    calendarIdWrite: null,
    syncStatus: 'ok',
    createdAt: Date.now(),
  }
  await ports.repositories({ consistency: 'bookmark' }).connections.create(conn)
  modes.set(conn.id, mode)
  return conn
}

function etBase(over: Partial<EventType>): Omit<EventType, 'createdAt'> {
  return {
    id: `evt_fc_${++n}`,
    ownerUserId: null,
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: `fc${n}`,
    title: 'Thirty minutes',
    description: '',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxHorizonDays: 60,
    maxPerDay: null,
    locationType: 'custom_link',
    locationValue: 'https://meet.punctual.test/room',
    questions: [],
    active: true,
    scheduleId: null,
    ...over,
  }
}

async function personalEvent(ports: EnginePorts, owner: User): Promise<EventType> {
  return ports.repositories({ consistency: 'bookmark' }).eventTypes.create(etBase({ ownerUserId: owner.id }))
}

/** A team event with an explicit host set; `required` per host for collective. */
async function teamEvent(
  ports: EnginePorts,
  schedulingType: 'collective' | 'round_robin',
  hosts: Array<{ user: User; required: boolean }>,
): Promise<EventType> {
  const teamId = `team_fc_${++n}`
  await env.DB.batch([
    env.DB.prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)').bind(teamId, 'T', `t-fc-${n}`, 0),
    ...hosts.map((h) =>
      env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(
        teamId, h.user.id, 'member', 1,
      ),
    ),
  ])
  const repos = ports.repositories({ consistency: 'bookmark' })
  const et = await repos.eventTypes.create(etBase({ ownerTeamId: teamId, schedulingType }))
  const ok = await repos.eventTypeHosts.replace(
    et.id,
    hosts.map((h) => ({ userId: h.user.id, required: h.required, scheduleId: null, rrWeight: null })),
  )
  if (!ok) throw new Error('eventTypeHosts.replace refused')
  return et
}

function attempt(et: EventType, hostUserIds: string[], over: Record<string, unknown> = {}) {
  return {
    eventTypeId: et.id,
    hostUserIds,
    start: START,
    end: END,
    guestName: 'Guest',
    guestEmail: `guest${++n}@example.com`,
    guestTimezone: 'UTC',
    answers: {},
    ...over,
  }
}

async function bookingsFor(eventTypeId: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?')
    .bind(eventTypeId)
    .first<{ n: number }>()
  return r?.n ?? 0
}

async function locksFor(hostUserId: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE host_user_id = ?')
    .bind(hostUserId)
    .first<{ n: number }>()
  return r?.n ?? 0
}

beforeEach(() => {
  modes.clear()
})

// ---- Commit path ---------------------------------------------------------

describe('commit: an unreadable calendar refuses the booking', () => {
  it('refuses with calendar_unavailable on a provider outage, and writes nothing', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'out')
    await connect(ports, host, 'outage')
    const et = await personalEvent(ports, host)

    const outcome = await ports.coordinator.book(host.id, attempt(et, [host.id]))

    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await bookingsFor(et.id)).toBe(0)
    expect(await locksFor(host.id)).toBe(0)
  })

  it('refuses on a 200 freeBusy response that carries a per-calendar error', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'fberr')
    await connect(ports, host, 'freebusy_error')
    const et = await personalEvent(ports, host)

    const outcome = await ports.coordinator.book(host.id, attempt(et, [host.id]))

    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await bookingsFor(et.id)).toBe(0)
  })

  it('refuses on a revoked grant AND marks the connection needs_reconnect', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'rev')
    const conn = await connect(ports, host, 'revoked')
    const et = await personalEvent(ports, host)

    const outcome = await ports.coordinator.book(host.id, attempt(et, [host.id]))

    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await bookingsFor(et.id)).toBe(0)
    const after = await ports.repositories({ consistency: 'bookmark' }).connections.byId(conn.id)
    expect(after?.syncStatus).toBe('needs_reconnect')
  })

  it('a refused commit leaks nothing: the idempotency key and the slot both book once the provider recovers', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'rec')
    const conn = await connect(ports, host, 'outage')
    const et = await personalEvent(ports, host)
    const hold = await ports.coordinator.hold(host.id, {
      eventTypeId: et.id,
      hostUserIds: [host.id],
      start: START,
      end: END,
      ttlMs: 5 * 60_000,
    })
    const req = attempt(et, [host.id], { idempotencyKey: `idem-${n}`, holdId: hold?.holdId })

    const refused = await ports.coordinator.book(host.id, req)
    expect(refused).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await locksFor(host.id)).toBe(0)

    // Recovery: the SAME request (same key, same hold, same slot) now books.
    // Were the idempotency claim leaked, this would come back as "already
    // being created"; were a lock leaked, as slot_taken.
    modes.set(conn.id, 'ok')
    const booked = await ports.coordinator.book(host.id, req)
    expect(booked.ok).toBe(true)
    if (!booked.ok) return
    expect(booked.booking.hostUserId).toBe(host.id)
    expect(booked.booking.startUtc).toBe(START)
    expect(await bookingsFor(et.id)).toBe(1)
  })

  it('collective: a REQUIRED host failing refuses, and the leases are released', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'cola')
    const b = await seedUser(ports, 'colb')
    await connect(ports, a, 'ok')
    await connect(ports, b, 'outage')
    const et = await teamEvent(ports, 'collective', [
      { user: a, required: true },
      { user: b, required: true },
    ])

    const outcome = await ports.coordinator.book(a.id, attempt(et, [a.id, b.id]))

    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await bookingsFor(et.id)).toBe(0)
    // Leases taken for the commit must be gone, or every later booking for
    // these hosts would fail lease_failed until the TTL.
    const lease = await ports.coordinator.lease([a.id, b.id], 5_000)
    expect(lease).not.toBeNull()
    if (lease) await ports.coordinator.releaseLease([a.id, b.id], lease.leaseId)
  })

  it('collective: an OPTIONAL host failing is treated as not attending, never as free', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'opta')
    const b = await seedUser(ports, 'optb')
    await connect(ports, a, 'ok')
    await connect(ports, b, 'outage')
    const et = await teamEvent(ports, 'collective', [
      { user: a, required: true },
      { user: b, required: false },
    ])

    const outcome = await ports.coordinator.book(a.id, attempt(et, [a.id, b.id]))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.booking.hostUserIds).toEqual([a.id])
    expect(await locksFor(b.id)).toBe(0)
  })

  it('round-robin: a failing member is skipped, never booked blind', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'rra')
    const b = await seedUser(ports, 'rrb')
    await connect(ports, a, 'outage')
    await connect(ports, b, 'ok')
    const et = await teamEvent(ports, 'round_robin', [
      { user: a, required: true },
      { user: b, required: true },
    ])

    const outcome = await ports.coordinator.book(a.id, attempt(et, [a.id, b.id]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.booking.hostUserIds).toEqual([b.id])

    // Every member unreadable: refused as calendar_unavailable, not "taken".
    const et2 = await teamEvent(ports, 'round_robin', [{ user: a, required: true }])
    const refused = await ports.coordinator.book(a.id, attempt(et2, [a.id]))
    expect(refused).toEqual({ ok: false, reason: 'calendar_unavailable' })
  })
})

describe('commit: more fail-closed edges', () => {
  it('round-robin: one member unreadable and the readable one busy is calendar_unavailable, not slot_taken', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'rrda')
    const b = await seedUser(ports, 'rrdb')
    await connect(ports, a, 'outage')
    await connect(ports, b, 'busy')
    const et = await teamEvent(ports, 'round_robin', [
      { user: a, required: true },
      { user: b, required: true },
    ])

    const outcome = await ports.coordinator.book(a.id, attempt(et, [a.id, b.id]))
    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await bookingsFor(et.id)).toBe(0)
  })

  it('a 200 freeBusy with no calendars key refuses instead of reading as free', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'nokey')
    await connect(ports, host, 'no_calendars_key')
    const et = await personalEvent(ports, host)
    const outcome = await ports.coordinator.book(host.id, attempt(et, [host.id]))
    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
  })

  it('a Google connection with an EMPTY read list is still read (as primary): down refuses', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'empty')
    await connect(ports, host, 'outage', [])
    const et = await personalEvent(ports, host)
    const outcome = await ports.coordinator.book(host.id, attempt(et, [host.id]))
    expect(outcome).toEqual({ ok: false, reason: 'calendar_unavailable' })
    expect(await bookingsFor(et.id)).toBe(0)
  })

  it('a Google connection with an EMPTY read list is still read (as primary): busy primary is not offered or booked', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'emptyb')
    await connect(ports, host, 'busy', [])
    const et = await personalEvent(ports, host)
    const listed = await createSlotService(ports).forEventType({
      eventType: et,
      hostUsers: [host],
      range: { start: START - 3_600_000, end: START + 3_600_000 },
    })
    expect(listed.some((s) => s.start < END && s.end > START)).toBe(false)
    const outcome = await ports.coordinator.book(host.id, attempt(et, [host.id]))
    expect(outcome.ok).toBe(false)
    expect(await bookingsFor(et.id)).toBe(0)
  })

  it('connect: a Google grant saved while listCalendars fails reads primary, never an empty green selection', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'conn')
    const saved = await saveCalendarConnection(
      {
        repos: ports.repositories({ consistency: 'bookmark' }),
        crypto: ports.crypto,
        clock: ports.clock,
        listCalendars: async () => {
          throw new Error('503 backendError')
        },
      },
      host.id,
      'google',
      { accessToken: 'at', refreshToken: 'rt', expiresInMs: 3_600_000, scope: 'calendar', accountEmail: '' },
    )
    const stored = await ports.repositories({ consistency: 'bookmark' }).connections.byId(saved.connection.id)
    expect(stored?.calendarIdsRead).toEqual(['primary'])
  })
})

// ---- Listing path --------------------------------------------------------

describe('listing: an unreadable calendar offers no slots', () => {
  it('returns zero slots for a failing personal host, reports it, and caches nothing', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'list')
    const conn = await connect(ports, host, 'outage')
    const et = await personalEvent(ports, host)
    const slots = createSlotService(ports)
    const range = { start: START - 2 * 3_600_000, end: START + 2 * 3_600_000 }

    const unavailable: string[] = []
    const none = await slots.forEventType({
      eventType: et,
      hostUsers: [host],
      range,
      onCalendarUnavailable: (id) => unavailable.push(id),
    })
    expect(none).toEqual([])
    expect(unavailable).toEqual([host.id])

    // The outage continues: a second listing must STILL offer nothing. Were
    // the failure cached as an empty busy set, this read would hit the cache
    // and list every slot as free.
    const still = await slots.forEventType({ eventType: et, hostUsers: [host], range })
    expect(still).toEqual([])

    // Recovery reads live: a failure was never cached as "no busy time"
    // (that would be fail-open) nor as "busy" (that would hide recovery).
    modes.set(conn.id, 'ok')
    const back = await slots.forEventType({ eventType: et, hostUsers: [host], range })
    expect(back.length).toBeGreaterThan(0)
  })

  it('an optional collective host being unreadable is NOT reported, so a full month says "no times"', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'nra')
    const b = await seedUser(ports, 'nrb')
    await connect(ports, a, 'ok')
    await connect(ports, b, 'outage')
    const et = await teamEvent(ports, 'collective', [
      { user: a, required: true },
      { user: b, required: false },
    ])
    const reported: string[] = []
    await createSlotService(ports).forEventType({
      eventType: et,
      hostUsers: [a, b],
      range: { start: START, end: START + 3_600_000 },
      onCalendarUnavailable: (id) => reported.push(id),
    })
    expect(reported).toEqual([])

    // A REQUIRED collective host is reported: it alone blocks every slot.
    const et2 = await teamEvent(ports, 'collective', [
      { user: a, required: true },
      { user: b, required: true },
    ])
    const reported2: string[] = []
    const none = await createSlotService(ports).forEventType({
      eventType: et2,
      hostUsers: [a, b],
      range: { start: START, end: START + 3_600_000 },
      onCalendarUnavailable: (id) => reported2.push(id),
    })
    expect(none).toEqual([])
    expect(reported2).toEqual([b.id])
  })

  it('round-robin: the readable member still lists', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'lra')
    const b = await seedUser(ports, 'lrb')
    await connect(ports, a, 'outage')
    await connect(ports, b, 'ok')
    const et = await teamEvent(ports, 'round_robin', [
      { user: a, required: true },
      { user: b, required: true },
    ])
    const found = await createSlotService(ports).forEventType({
      eventType: et,
      hostUsers: [a, b],
      range: { start: START, end: START + 3_600_000 },
    })
    expect(found.length).toBeGreaterThan(0)
    for (const s of found) expect(s.eligibleHostIds).toEqual([b.id])
  })
})

// ---- HTTP surfaces -------------------------------------------------------

function page(ports: EnginePorts): Hono {
  return buildRouter(ports, createSlotService(ports)) as unknown as Hono
}

function monthOf(t: number): string {
  return new Date(t).toISOString().slice(0, 7)
}

describe('the public booking page', () => {
  it('says "temporarily unavailable" instead of "no times" when the calendar cannot be read', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'pg')
    await connect(ports, host, 'outage')
    const et = await personalEvent(ports, host)

    const res = await page(ports).request(
      `/${host.slug}/${et.slug}?month=${monthOf(START)}&date=${new Date(START).toISOString().slice(0, 10)}&tz=UTC`,
      { headers: { 'cf-connecting-ip': `10.0.0.${++n % 250}` } },
    )
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('Temporarily unavailable')
    expect(html).not.toContain('No times available')
  })

  it('a healthy calendar still shows the normal slot list', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'pgok')
    await connect(ports, host, 'ok')
    const et = await personalEvent(ports, host)
    const res = await page(ports).request(`/${host.slug}/${et.slug}?month=${monthOf(START)}&tz=UTC`, {
      headers: { 'cf-connecting-ip': `10.0.1.${++n % 250}` },
    })
    expect(await res.text()).not.toContain('Temporarily unavailable')
  })

  it('renders a calendar_unavailable refusal as a friendly 503, not a 500, and books nothing', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'post')
    await connect(ports, host, 'outage')
    const et = await personalEvent(ports, host)
    const form = new FormData()
    form.set('start', String(START))
    form.set('tz', 'UTC')
    form.set('name', 'Guest')
    form.set('email', 'guest@example.com')

    const res = await page(ports).request(`/${host.slug}/${et.slug}/confirm`, {
      method: 'POST',
      body: form,
      headers: { 'cf-connecting-ip': `10.0.2.${++n % 250}` },
    })
    const html = await res.text()
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(html).toContain('Temporarily unavailable')
    expect(html).toContain('nothing has been booked')
    expect(await bookingsFor(et.id)).toBe(0)
  })

  it('a guest cannot swap the host: client-supplied host ids are ignored, host A is booked', async () => {
    const ports = testPorts()
    const a = await seedUser(ports, 'swa')
    const b = await seedUser(ports, 'swb')
    await connect(ports, a, 'ok')
    const et = await personalEvent(ports, a)
    const form = new FormData()
    form.set('start', String(START))
    form.set('tz', 'UTC')
    form.set('name', 'Guest')
    form.set('email', 'swap@example.com')
    // Every plausible spelling of "book someone else" a hostile form could carry.
    for (const k of ['host', 'hostId', 'hostUserId', 'hostUserIds', 'userId', 'user', 'owner']) form.set(k, b.id)

    const res = await page(ports).request(`/${a.slug}/${et.slug}/confirm`, {
      method: 'POST',
      body: form,
      headers: { 'cf-connecting-ip': `10.0.3.${++n % 250}` },
    })
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT host_user_id FROM bookings WHERE event_type_id = ?')
      .bind(et.id)
      .first<{ host_user_id: string }>()
    expect(row?.host_user_id).toBe(a.id)
    expect(await locksFor(b.id)).toBe(0)
  })
})

describe('guest reschedule', () => {
  it('a refused move says the calendar cannot be checked, not "That time was just taken"', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'mv')
    const conn = await connect(ports, host, 'ok')
    const et = await personalEvent(ports, host)
    const booked = await ports.coordinator.book(host.id, attempt(et, [host.id]))
    expect(booked.ok).toBe(true)
    if (!booked.ok || !booked.manageToken) throw new Error('setup: expected a manage token')

    modes.set(conn.id, 'outage')
    const form = new FormData()
    form.set('token', booked.manageToken)
    form.set('start', String(START + 2 * 3_600_000))
    const res = await page(ports).request(`/booking/${booked.booking.id}/reschedule`, {
      method: 'POST',
      body: form,
      headers: { 'cf-connecting-ip': `10.0.4.${++n % 250}` },
    })
    const html = await res.text()
    expect(res.status).toBe(409)
    expect(html).toContain('the booking was not moved')
    expect(html).not.toContain('That time was just taken')
    expect(await bookingsFor(et.id)).toBe(1)
  })
})

describe('REST', () => {
  it('maps calendar_unavailable to a retryable 503 problem', async () => {
    const ports = testPorts()
    const host = await seedUser(ports, 'rest')
    await connect(ports, host, 'outage')
    const et = await personalEvent(ports, host)
    const repos = ports.repositories({ consistency: 'bookmark' })
    const { raw } = await createApiKey(
      { repos, crypto: ports.crypto },
      { userId: host.id, name: 'k', scopes: ['*'], now: Date.now() },
    )
    const app = new Hono()
    app.route('/api/v1', buildApiRoutes(ports, createSlotService(ports)))

    const res = await app.request('/api/v1/bookings', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        eventTypeId: et.id,
        start: new Date(START).toISOString(),
        guestName: 'Guest',
        guestEmail: 'rest@example.com',
        guestTimezone: 'UTC',
      }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(res.status, JSON.stringify(body)).toBe(503)
    expect(body['title']).toBe('Calendar unavailable')
    expect(res.headers.get('retry-after')).toBe('30')
    expect(await bookingsFor(et.id)).toBe(0)
  })
})
