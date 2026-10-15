/**
 * Guest personal-data retention and erasure (SwayQ ADR-0082; SWA-1290),
 * against real D1 under the Workers runtime.
 *
 * What is asserted: the 12-month boundary (11 months kept, 13 anonymised), the
 * tombstone's shape and that the row's non-personal columns survive, that a
 * second run changes nothing, that one tick is bounded, that the cron actually
 * calls the sweep, that the erase-by-email action reaches every table that
 * holds a guest (bookings, idempotency records by scope AND by response body,
 * login tokens), cancels future meetings through the normal path BEFORE
 * anonymising, writes a count-only audit line, and is admin-only and
 * CSRF-protected.
 */

import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildDashboardRoutes } from '../../src/http/dashboard-routes.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { purgeExpiredGuestData } from '../../src/adapters/guest-data.js'
import { runScheduledTasks } from '../../src/adapters/scheduled.js'
import {
  GUEST_DATA_RETENTION_MONTHS,
  RETENTION_BATCH,
  TOMBSTONE,
  retentionCutoff,
} from '../../src/core/domain/guest-data.js'
import { SESSION_ABSOLUTE_TTL_MS, SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../../src/core/domain/auth-service.js'
import { createFakeBlobStorage, createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type { SlotService } from '../../src/engine.js'
import type {
  BlobCache,
  Cache as CachePort,
  CalendarProviders,
  EnginePorts,
  HostCoordinator,
  QueueMessage,
  QueuePort,
} from '../../src/ports.js'

const db = env.DB
const BASE = 'http://localhost'
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const MIN = 60_000

const ADMIN_ID = 'usr_gd_admin'
const MEMBER_ID = 'usr_gd_member'
const HOST_A = 'usr_gd_host_a'
const HOST_B = 'usr_gd_host_b'
const ET_A = 'et_gd_a'
const ET_B = 'et_gd_b'

function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

const crypto_ = createWebCrypto({ keys: { 1: keyMaterial(1) }, currentVersion: 1, signingKey: keyMaterial(9) })

const calendars: CalendarProviders = {
  get() {
    throw new Error('test: no calendar provider is configured')
  },
  available: () => [],
}
const cache: CachePort = { async get() { return null }, async put() {}, async delete() {} }
const blobCache: BlobCache = { async get() { return null }, async put() {} }

const sent: QueueMessage[] = []
const queue: QueuePort = {
  async send(message) { sent.push(message) },
  async sendBatch(messages) { sent.push(...messages) },
}

const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(db, scope),
  calendars,
  oauth: { forProvider: () => null, redirectUri: (n, p) => `${BASE}/auth/${n}/callback?purpose=${p}` },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache,
  blobCache,
  blobStorage: createFakeBlobStorage(),
  // The dashboard's session checks read the real clock for expiry; the sweep
  // takes `now` explicitly, so the fixed NOW above only seeds ages.
  clock: { now: () => Date.now() },
  queue,
  coordinator: new Proxy({} as HostCoordinator, { get: () => () => { throw new Error('test: coordinator not stubbed') } }),
  rateLimiter: createFakeRateLimiter(),
  config: fakeConfig({ baseUrl: BASE }),
}

const slots: SlotService = { async forEventType() { return [] } }
const app = buildDashboardRoutes(ports, slots)

/** The wall clock is what the route uses; seed "future" and "past" relative to it. */
const REAL_NOW = Date.now()

function monthsAgo(months: number, from = NOW): number {
  const d = new Date(from)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.getTime()
}

interface Seed {
  id: string
  start: number
  email?: string
  name?: string
  status?: string
  host?: string
  eventType?: string
  answers?: Record<string, string>
  locale?: string | null
  tz?: string
  externalEventIds?: Record<string, string>
}

async function seedBooking(b: Seed): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bookings
       (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,
        start_utc,end_utc,local_date,status,answers_json,external_event_ids_json,reschedule_of,
        rescheduled_to,manage_token_hash,cancelled_at,created_at,guest_locale)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      b.id, b.eventType ?? ET_A, b.host ?? HOST_A, JSON.stringify([b.host ?? HOST_A]),
      b.name ?? 'Grace Hopper', b.email ?? 'grace@example.test', b.tz ?? 'America/New_York',
      b.start, b.start + 30 * MIN, new Date(b.start).toISOString().slice(0, 10),
      b.status ?? 'confirmed', JSON.stringify(b.answers ?? { company: 'Navy' }),
      JSON.stringify(b.externalEventIds ?? {}), null, null, await crypto_.hash(`seed_${b.id}`),
      null, b.start, b.locale === undefined ? 'en' : b.locale,
    )
    .run()
}

interface Row {
  id: string
  guest_name: string
  guest_email: string
  guest_timezone: string
  guest_locale: string | null
  answers_json: string
  start_utc: number
  end_utc: number
  host_user_id: string
  event_type_id: string
  status: string
  external_event_ids_json: string
}
async function row(id: string): Promise<Row> {
  return (await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<Row>())!
}
async function isTombstoned(id: string): Promise<boolean> {
  return (await row(id)).guest_email === TOMBSTONE.guestEmail
}
async function count(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
}

async function seedSession(userId: string): Promise<string> {
  const token = crypto_.randomToken(32)
  await db
    .prepare('INSERT INTO sessions (id_hash,user_id,expires_at,absolute_expires_at,bookmark,created_at) VALUES (?,?,?,?,?,?)')
    .bind(await crypto_.hash(token), userId, REAL_NOW + SESSION_TTL_MS, REAL_NOW + SESSION_ABSOLUTE_TTL_MS, null, REAL_NOW)
    .run()
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function csrfFrom(cookie: string, path = '/dashboard/admin'): Promise<string> {
  const page = await app.fetch(new Request(`${BASE}${path}`, { headers: { cookie } }))
  return /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
}

async function postErase(fields: Record<string, string>, cookie?: string): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return app.fetch(
    new Request(`${BASE}/dashboard/admin/erase-guest`, { method: 'POST', body: form, ...(cookie ? { headers: { cookie } } : {}) }),
  )
}

async function wipe(): Promise<void> {
  for (const t of ['bookings', 'idempotency_keys', 'magic_link_tokens', 'guest_erasure_log']) {
    await db.prepare(`DELETE FROM ${t}`).run()
  }
}

beforeAll(async () => {
  const insert = 'INSERT INTO users (id,email,name,tz,slug,created_at,role) VALUES (?,?,?,?,?,?,?)'
  await db.prepare(insert).bind(ADMIN_ID, 'admin-gd@example.test', 'Admin', 'UTC', 'admin-gd', REAL_NOW, 'admin').run()
  await db.prepare(insert).bind(MEMBER_ID, 'member-gd@example.test', 'Member', 'UTC', 'member-gd', REAL_NOW, 'member').run()
  await db.prepare(insert).bind(HOST_A, 'host-a-gd@example.test', 'Host A', 'UTC', 'host-a-gd', REAL_NOW, 'member').run()
  await db.prepare(insert).bind(HOST_B, 'host-b-gd@example.test', 'Host B', 'UTC', 'host-b-gd', REAL_NOW, 'member').run()
  const eventType = `INSERT INTO event_types
    (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
     slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
     max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  for (const [id, owner] of [[ET_A, HOST_A], [ET_B, HOST_B]] as const) {
    await db.prepare(eventType).bind(id, owner, null, 'personal', `intro-${id}`, 'Intro', '', 30, null, 0, 0, 0, 60, null, 'google_meet', null, '[]', 1, REAL_NOW).run()
  }
})

beforeEach(async () => {
  sent.length = 0
  await wipe()
})

// ---------------------------------------------------------------------------

describe('retention boundary', () => {
  it('uses calendar months, clamped at month end, and is defined once as 12', () => {
    expect(GUEST_DATA_RETENTION_MONTHS).toBe(12)
    expect(retentionCutoff(Date.UTC(2026, 9, 16, 12))).toBe(Date.UTC(2025, 9, 16, 12))
    // 29 Feb 2028 minus 12 months has no 29 Feb 2027: clamp to 28 Feb.
    expect(retentionCutoff(Date.UTC(2028, 1, 29, 8))).toBe(Date.UTC(2027, 1, 28, 8))
  })

  it('anonymises a meeting that ended 13 months ago and leaves one from 11 months ago alone', async () => {
    await seedBooking({ id: 'bk_old', start: monthsAgo(13) })
    await seedBooking({ id: 'bk_recent', start: monthsAgo(11) })

    await purgeExpiredGuestData(ports, NOW)

    expect(await isTombstoned('bk_old')).toBe(true)
    const recent = await row('bk_recent')
    expect(recent.guest_email).toBe('grace@example.test')
    expect(recent.guest_name).toBe('Grace Hopper')
    expect(recent.answers_json).toContain('Navy')
  })

  it('judges by when the meeting ENDED, not when it started', async () => {
    // Starts just over 12 months ago, but is 30 minutes long: ended inside the window? No: ended 12 months minus 0.
    // Start 12 months + 10 minutes ago, ends 12 months - 20 minutes ago: still retained.
    await seedBooking({ id: 'bk_edge', start: retentionCutoff(NOW) - 10 * MIN })
    await purgeExpiredGuestData(ports, NOW)
    expect(await isTombstoned('bk_edge')).toBe(false)
    // One that ended a minute before the cutoff goes.
    await seedBooking({ id: 'bk_gone', start: retentionCutoff(NOW) - 31 * MIN })
    await purgeExpiredGuestData(ports, NOW)
    expect(await isTombstoned('bk_gone')).toBe(true)
  })

  it('writes the fixed tombstone, keeps every non-personal column, and clears locale and timezone', async () => {
    await seedBooking({ id: 'bk_shape', start: monthsAgo(14), status: 'cancelled', externalEventIds: { c1: 'evt_1' }, host: HOST_B, eventType: ET_B })
    const before = await row('bk_shape')
    await purgeExpiredGuestData(ports, NOW)
    const after = await row('bk_shape')

    expect(after.guest_name).toBe(TOMBSTONE.guestName)
    expect(after.guest_email).toBe(TOMBSTONE.guestEmail)
    expect(after.guest_email.endsWith('.invalid')).toBe(true)
    expect(after.answers_json).toBe('{}')
    expect(after.guest_locale).toBeNull()
    expect(after.guest_timezone).toBe('UTC')
    for (const k of ['id', 'start_utc', 'end_utc', 'host_user_id', 'event_type_id', 'status', 'external_event_ids_json'] as const) {
      expect(after[k]).toEqual(before[k])
    }
  })

  it('is idempotent: a second run changes nothing', async () => {
    await seedBooking({ id: 'bk_i1', start: monthsAgo(13) })
    await seedBooking({ id: 'bk_i2', start: monthsAgo(20) })
    await purgeExpiredGuestData(ports, NOW)
    const first = [await row('bk_i1'), await row('bk_i2')]
    const changed = await createD1Repositories(db, { consistency: 'bookmark' }).guestData.anonymiseEndedBefore(retentionCutoff(NOW), RETENTION_BATCH)
    expect(changed).toBe(0)
    await purgeExpiredGuestData(ports, NOW)
    expect([await row('bk_i1'), await row('bk_i2')]).toEqual(first)
  })

  it('bounds one tick to RETENTION_BATCH rows, oldest first, and the next tick finishes the job', async () => {
    const total = RETENTION_BATCH + 40
    for (let i = 0; i < total; i++) await seedBooking({ id: `bk_b${i}`, start: monthsAgo(13) - i * 1000 })
    await purgeExpiredGuestData(ports, NOW)
    const done = (await db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE guest_email = ?').bind(TOMBSTONE.guestEmail).first<{ n: number }>())!.n
    expect(done).toBe(RETENTION_BATCH)
    // Oldest first: the very oldest is in the first batch, the newest is not.
    expect(await isTombstoned(`bk_b${total - 1}`)).toBe(true)
    expect(await isTombstoned('bk_b0')).toBe(false)
    await purgeExpiredGuestData(ports, NOW)
    expect(await isTombstoned('bk_b0')).toBe(true)
  })

  it('also deletes expired idempotency records and login tokens, and keeps live ones', async () => {
    const idem = 'INSERT INTO idempotency_keys (key,scope,request_hash,response_json,status,expires_at) VALUES (?,?,?,?,?,?)'
    await db.prepare(idem).bind('k_dead', 'booking:et:grace@example.test', 'h', '{"guestEmail":"grace@example.test"}', 201, NOW - 1).run()
    await db.prepare(idem).bind('k_live', 'booking:et:grace@example.test', 'h', '{}', 201, NOW + DAY).run()
    const magic = 'INSERT INTO magic_link_tokens (token_hash,email,expires_at,created_at) VALUES (?,?,?,?)'
    await db.prepare(magic).bind('t_dead', 'someone@example.test', NOW - 1, NOW - DAY).run()
    await db.prepare(magic).bind('t_live', 'someone@example.test', NOW + DAY, NOW).run()

    await purgeExpiredGuestData(ports, NOW)

    const keys = (await db.prepare('SELECT key FROM idempotency_keys').all<{ key: string }>()).results.map((r) => r.key)
    expect(keys).toEqual(['k_live'])
    const tokens = (await db.prepare('SELECT token_hash FROM magic_link_tokens').all<{ token_hash: string }>()).results.map((r) => r.token_hash)
    expect(tokens).toEqual(['t_live'])
  })

  it('never throws out of the cron, and logs counts only', async () => {
    await seedBooking({ id: 'bk_log', start: monthsAgo(13) })
    const lines: string[] = []
    const original = console.log
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    try {
      await purgeExpiredGuestData(ports, NOW)
      const broken: EnginePorts = {
        ...ports,
        repositories: () => { throw new Error('d1 down for grace@example.test') },
      }
      await expect(purgeExpiredGuestData(broken, NOW)).resolves.toBeUndefined()
    } finally {
      console.log = original
    }
    const joined = lines.join('\n')
    expect(joined).toContain('retention_purged')
    expect(joined).not.toContain('grace')
    expect(joined).not.toContain('Hopper')
  })

  it('runs from the scheduled entry point', async () => {
    await seedBooking({ id: 'bk_cron', start: monthsAgo(13) })
    await runScheduledTasks(ports, NOW)
    expect(await isTombstoned('bk_cron')).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('erase by email', () => {
  const GUEST = 'grace@example.test'

  async function seedGuestEverywhere(): Promise<void> {
    // Two hosts, mixed-case email, past bookings of several statuses.
    await seedBooking({ id: 'bk_e1', start: REAL_NOW - 3 * DAY, host: HOST_A, eventType: ET_A })
    await seedBooking({ id: 'bk_e2', start: REAL_NOW - 40 * DAY, host: HOST_B, eventType: ET_B, status: 'cancelled', email: GUEST })
    await seedBooking({ id: 'bk_e3', start: REAL_NOW - 9 * DAY, host: HOST_B, eventType: ET_B, status: 'rescheduled' })
    await seedBooking({ id: 'bk_other', start: REAL_NOW - 3 * DAY, email: 'other@example.test', name: 'Other Person' })
    const idem = 'INSERT INTO idempotency_keys (key,scope,request_hash,response_json,status,expires_at) VALUES (?,?,?,?,?,?)'
    await db.prepare(idem).bind('k_scope', `booking:${ET_A}:${GUEST}`, 'h', '{}', 201, REAL_NOW + DAY).run()
    await db.prepare(idem).bind('k_body', 'rest:key', 'h', JSON.stringify({ booking: { guestEmail: 'Grace@Example.Test' } }), 201, REAL_NOW + DAY).run()
    await db.prepare(idem).bind('k_other', `booking:${ET_A}:other@example.test`, 'h', '{}', 201, REAL_NOW + DAY).run()
    const magic = 'INSERT INTO magic_link_tokens (token_hash,email,expires_at,created_at) VALUES (?,?,?,?)'
    await db.prepare(magic).bind('t_guest', GUEST, REAL_NOW + DAY, REAL_NOW).run()
    await db.prepare(magic).bind('t_other', 'other@example.test', REAL_NOW + DAY, REAL_NOW).run()
  }

  it('reaches every table that holds a guest, across hosts and statuses, and nobody else', async () => {
    await seedGuestEverywhere()
    const cookie = await seedSession(ADMIN_ID)
    const res = await postErase({ csrf: await csrfFrom(cookie), email: '  GRACE@example.test ', confirm: 'yes' }, cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Erased 3 bookings')

    for (const id of ['bk_e1', 'bk_e2', 'bk_e3']) expect(await isTombstoned(id)).toBe(true)
    expect((await row('bk_other')).guest_email).toBe('other@example.test')
    const keys = (await db.prepare('SELECT key FROM idempotency_keys').all<{ key: string }>()).results.map((r) => r.key)
    expect(keys).toEqual(['k_other'])
    const tokens = (await db.prepare('SELECT token_hash FROM magic_link_tokens').all<{ token_hash: string }>()).results.map((r) => r.token_hash)
    expect(tokens).toEqual(['t_other'])
  })

  it('writes a count-only audit line that cannot identify the guest', async () => {
    await seedGuestEverywhere()
    const cookie = await seedSession(ADMIN_ID)
    await postErase({ csrf: await csrfFrom(cookie), email: GUEST, confirm: 'yes' }, cookie)

    const rows = (await db.prepare('SELECT * FROM guest_erasure_log').all<Record<string, unknown>>()).results
    expect(rows).toHaveLength(1)
    const entry = rows[0]!
    expect(entry['actor_user_id']).toBe(ADMIN_ID)
    expect(entry['bookings_anonymised']).toBe(3)
    expect(entry['bookings_cancelled']).toBe(0)
    expect(entry['idempotency_deleted']).toBe(2)
    expect(entry['magic_links_deleted']).toBe(1)
    expect(Number(entry['at'])).toBeGreaterThan(0)
    const dump = JSON.stringify(entry).toLowerCase()
    expect(dump).not.toContain('grace')
    expect(dump).not.toContain('example.test')
  })

  it('cancels a FUTURE confirmed booking through the normal path first, then anonymises it', async () => {
    await seedBooking({
      id: 'bk_future',
      start: REAL_NOW + 3 * DAY,
      externalEventIds: { conn_a: 'evt_future' },
    })
    const cookie = await seedSession(ADMIN_ID)
    const res = await postErase({ csrf: await csrfFrom(cookie), email: GUEST, confirm: 'yes' }, cookie)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('1 upcoming meeting cancelled first')

    const after = await row('bk_future')
    expect(after.status).toBe('cancelled')
    expect(after.guest_email).toBe(TOMBSTONE.guestEmail)
    // The event ids survive so the calendar delete can still reach Google.
    expect(JSON.parse(after.external_event_ids_json)).toEqual({ conn_a: 'evt_future' })

    // The Google event is removed by the normal cancel path's sync message...
    expect(sent.some((m) => m.kind === 'calendar.sync' && m.bookingId === 'bk_future' && m.action === 'delete')).toBe(true)
    // ...and the guest was told, with their real address, before it was erased.
    const toGuest = sent.filter((m) => m.kind === 'email' && m.message.to === GUEST)
    expect(toGuest.length).toBeGreaterThan(0)
    const log = (await db.prepare('SELECT bookings_cancelled, bookings_anonymised FROM guest_erasure_log').first<{ bookings_cancelled: number; bookings_anonymised: number }>())!
    expect(log).toEqual({ bookings_cancelled: 1, bookings_anonymised: 1 })
  })

  it('does not cancel a past booking or an already cancelled one', async () => {
    await seedBooking({ id: 'bk_past', start: REAL_NOW - 2 * DAY })
    await seedBooking({ id: 'bk_cx', start: REAL_NOW + 2 * DAY, status: 'cancelled' })
    const cookie = await seedSession(ADMIN_ID)
    await postErase({ csrf: await csrfFrom(cookie), email: GUEST, confirm: 'yes' }, cookie)
    expect(sent.some((m) => m.kind === 'calendar.sync')).toBe(false)
    expect((await row('bk_past')).status).toBe('confirmed')
    expect((await row('bk_cx')).status).toBe('cancelled')
    expect(await isTombstoned('bk_past')).toBe(true)
  })

  it('is admin-only: a member gets 403 and nothing changes', async () => {
    await seedGuestEverywhere()
    const cookie = await seedSession(MEMBER_ID)
    // A VALID token for the member's own session, from a page a member may
    // open: otherwise this would 403 on CSRF and prove nothing about the role.
    const csrf = await csrfFrom(cookie, '/dashboard/settings')
    expect(csrf).not.toBe('')
    const res = await postErase({ csrf, email: GUEST, confirm: 'yes' }, cookie)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Forbidden')
    expect(await isTombstoned('bk_e1')).toBe(false)
    expect(await count('guest_erasure_log')).toBe(0)
    expect(await count('idempotency_keys')).toBe(3)
  })

  it('refuses an anonymous request', async () => {
    await seedGuestEverywhere()
    const res = await postErase({ email: GUEST, confirm: 'yes' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect(await isTombstoned('bk_e1')).toBe(false)
  })

  it('is CSRF-protected: an admin without a valid token gets 403 and nothing changes', async () => {
    await seedGuestEverywhere()
    const cookie = await seedSession(ADMIN_ID)
    for (const csrf of [undefined, 'not-the-token']) {
      const res = await postErase({ ...(csrf ? { csrf } : {}), email: GUEST, confirm: 'yes' }, cookie)
      expect(res.status).toBe(403)
    }
    expect(await isTombstoned('bk_e1')).toBe(false)
    expect(await count('guest_erasure_log')).toBe(0)
  })

  it('needs the confirm box and a real address', async () => {
    await seedGuestEverywhere()
    const cookie = await seedSession(ADMIN_ID)
    const csrf = await csrfFrom(cookie)
    expect((await postErase({ csrf, email: GUEST }, cookie)).status).toBe(400)
    expect((await postErase({ csrf, email: 'not-an-email', confirm: 'yes' }, cookie)).status).toBe(400)
    expect(await isTombstoned('bk_e1')).toBe(false)
  })

  it('cannot be aimed at the tombstone address', async () => {
    await seedBooking({ id: 'bk_t', start: monthsAgo(14) })
    await purgeExpiredGuestData(ports, NOW)
    const cookie = await seedSession(ADMIN_ID)
    const res = await postErase({ csrf: await csrfFrom(cookie), email: TOMBSTONE.guestEmail, confirm: 'yes' }, cookie)
    expect(await res.text()).toContain('Erased 0 bookings')
  })

  it('shows the form on the admin page', async () => {
    const cookie = await seedSession(ADMIN_ID)
    const html = await (await app.fetch(new Request(`${BASE}/dashboard/admin`, { headers: { cookie } }))).text()
    expect(html).toContain('action="/dashboard/admin/erase-guest"')
  })
})
