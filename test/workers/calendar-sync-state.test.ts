/**
 * Calendar sync state against REAL D1 (migration 0018, SWA-1286): the
 * columns exist with their defaults and CHECK, the conditional moves the
 * consumer and reconciler rely on are conditional in SQL, and a drifted
 * booking's guest manage link refuses to reschedule or cancel.
 */

import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildDashboardRoutes } from '../../src/http/dashboard-routes.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { issueManageToken } from '../../src/core/domain/auth-flows.js'
import { createFakeBlobStorage, createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type { SlotService } from '../../src/engine.js'
import type { Booking } from '../../src/core/domain/types.js'
import type { EnginePorts, HostCoordinator } from '../../src/ports.js'

const db = env.DB
const BASE = 'http://localhost'
const NOW = Date.now()
const HOST_ID = 'usr_sync_host'
const EVENT_ID = 'evt_sync'

function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  return btoa(String.fromCharCode(...bytes))
}
const crypto_ = createWebCrypto({ keys: { 1: keyMaterial(1) }, currentVersion: 1, signingKey: keyMaterial(9) })

const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(db, scope),
  calendars: { get() { throw new Error('test: no provider') }, available: () => [] },
  oauth: { forProvider: () => null, redirectUri: () => BASE },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache: { async get() { return null }, async put() {}, async delete() {} },
  blobCache: { async get() { return null }, async put() {} },
  blobStorage: createFakeBlobStorage(),
  clock: { now: () => Date.now() },
  queue: { async send() {}, async sendBatch() {} },
  coordinator: new Proxy({} as HostCoordinator, { get: () => () => { throw new Error('test: coordinator') } }),
  rateLimiter: createFakeRateLimiter(),
  config: fakeConfig({ baseUrl: BASE }),
}
const slots: SlotService = { async forEventType() { return [] } }
const app = buildDashboardRoutes(ports, slots)
const repos = () => createD1Repositories(db, { consistency: 'bookmark' })

async function post(path: string, body: Record<string, string>): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) form.append(k, v)
  return app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form }))
}

function booking(id: string, over: Partial<Booking> = {}): Booking {
  const start = NOW + 2 * 86_400_000
  return {
    id, eventTypeId: EVENT_ID, hostUserId: HOST_ID, hostUserIds: [HOST_ID], guestName: 'G', guestEmail: 'g@example.test',
    guestTimezone: 'UTC', startUtc: start, endUtc: start + 1_800_000, localDate: '2026-10-18', status: 'confirmed',
    answers: {}, externalEventIds: {}, conferenceUrl: null, rescheduleOf: null, rescheduledTo: null,
    manageTokenHash: `hash_${id}`, cancelledAt: null, createdAt: NOW - 3_600_000, ...over,
  }
}

async function insert(b: Booking): Promise<void> {
  await db.prepare('DELETE FROM bookings WHERE id = ?').bind(b.id).run()
  const written = await repos().bookings.createWithLocks(b, [])
  expect(written?.id).toBe(b.id)
}

beforeAll(async () => {
  await db.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
    .bind(HOST_ID, 'synchost@example.test', 'Sync Host', 'UTC', 'sync-host', NOW).run()
  await db.prepare(
    `INSERT INTO event_types
     (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
      slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
      max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(EVENT_ID, HOST_ID, null, 'personal', 'sync', 'Sync call', '', 30, null, 0, 0, 0, 60, null, 'in_person', null, '[]', 1, NOW).run()
})

describe('migration 0018', () => {
  it('adds the columns, defaults a new booking to pending, and round-trips guest_locale', async () => {
    const cols = await db.prepare('PRAGMA table_info(bookings)').all<{ name: string }>()
    const names = (cols.results ?? []).map((c) => c.name)
    for (const c of ['calendar_sync_status', 'calendar_sync_attempts', 'calendar_sync_error', 'calendar_synced_at', 'guest_locale']) {
      expect(names).toContain(c)
    }
    await insert(booking('bk_new', { guestLocale: 'da' }))
    const read = await repos().bookings.byId('bk_new')
    expect(read).toMatchObject({ calendarSyncStatus: 'pending', calendarSyncAttempts: 0, calendarSyncError: null, guestLocale: 'da' })
  })

  it('refuses a status outside the four', async () => {
    await insert(booking('bk_check'))
    await expect(db.prepare("UPDATE bookings SET calendar_sync_status = 'bogus' WHERE id = 'bk_check'").run()).rejects.toThrow()
  })
})

describe('conditional state moves (real SQL)', () => {
  it('failed is reached once; a dead-letter give-up never fails a synced booking', async () => {
    await insert(booking('bk_fail'))
    expect(await repos().bookings.markCalendarSyncFailed('bk_fail', 'not_found')).toBe(true)
    expect(await repos().bookings.markCalendarSyncFailed('bk_fail', 'not_found')).toBe(false)
    expect(await repos().bookings.byId('bk_fail')).toMatchObject({ calendarSyncStatus: 'failed', calendarSyncError: 'not_found', calendarSyncAttempts: 1 })

    await insert(booking('bk_ok'))
    await repos().bookings.markCalendarSynced('bk_ok', NOW)
    expect(await repos().bookings.markCalendarSyncFailed('bk_ok', null, { fromPendingOnly: true })).toBe(false)
    expect((await repos().bookings.byId('bk_ok'))?.calendarSyncStatus).toBe('synced')
  })

  it('a dead-letter give-up keeps the last category, or falls back to retries_exhausted', async () => {
    await insert(booking('bk_dlq'))
    await repos().bookings.recordCalendarSyncRetry('bk_dlq', 'rate_limited', NOW)
    expect(await repos().bookings.markCalendarSyncFailed('bk_dlq', null, { fromPendingOnly: true })).toBe(true)
    expect(await repos().bookings.byId('bk_dlq')).toMatchObject({ calendarSyncError: 'rate_limited', calendarSyncAttempts: 2 })

    await insert(booking('bk_dlq2'))
    await repos().bookings.markCalendarSyncFailed('bk_dlq2', null)
    expect((await repos().bookings.byId('bk_dlq2'))?.calendarSyncError).toBe('retries_exhausted')
  })

  it('drifted is reached once, only from synced; a create pass does not clear it, an update does', async () => {
    await insert(booking('bk_drift', { externalEventIds: { c: 'e' } }))
    expect(await repos().bookings.markCalendarDrifted('bk_drift')).toBe(false) // still pending
    await repos().bookings.markCalendarSynced('bk_drift', NOW)
    expect(await repos().bookings.markCalendarDrifted('bk_drift')).toBe(true)
    expect(await repos().bookings.markCalendarDrifted('bk_drift')).toBe(false)
    await repos().bookings.markCalendarSynced('bk_drift', NOW)
    expect((await repos().bookings.byId('bk_drift'))?.calendarSyncStatus).toBe('drifted')
    await repos().bookings.markCalendarSynced('bk_drift', NOW, { clearDrift: true })
    expect((await repos().bookings.byId('bk_drift'))?.calendarSyncStatus).toBe('synced')
  })

  it('the reconciler queries select what they promise', async () => {
    await insert(booking('bk_stuck', { createdAt: NOW - 20 * 60_000 }))
    await insert(booking('bk_fresh', { createdAt: NOW - 60_000 }))
    const stuck = (await repos().bookings.listStuckCalendarSyncs(NOW, NOW - 10 * 60_000, 100, NOW - 20 * 60_000)).map((b) => b.id)
    expect(stuck).toContain('bk_stuck')
    expect(stuck).not.toContain('bk_fresh')
    expect(stuck).not.toContain('bk_fail')

    await insert(booking('bk_check_old', { externalEventIds: { c: 'e1' } }))
    await insert(booking('bk_check_new', { externalEventIds: { c: 'e2' } }))
    await repos().bookings.markCalendarSynced('bk_check_old', NOW - 1000)
    await repos().bookings.markCalendarSynced('bk_check_new', NOW)
    const drift = (await repos().bookings.listCalendarDriftCandidates({ start: NOW, end: NOW + 30 * 86_400_000 }, 100)).map((b) => b.id)
    expect(drift.indexOf('bk_check_old')).toBeLessThan(drift.indexOf('bk_check_new'))
    expect(drift).not.toContain('bk_stuck') // pending, no ids
  })
})

describe('guest manage link on a drifted booking', () => {
  async function seedDrifted(id: string): Promise<string> {
    const b = booking(id, { externalEventIds: { c: 'e' } })
    const issued = await issueManageToken({ crypto: crypto_ }, { id, startUtc: b.startUtc }, 'manage')
    await insert({ ...b, manageTokenHash: issued.tokenHash })
    await repos().bookings.markCalendarSynced(id, NOW)
    expect(await repos().bookings.markCalendarDrifted(id)).toBe(true)
    return issued.token
  }

  it('refuses a reschedule with a message telling the guest to contact the host', async () => {
    const token = await seedDrifted('bk_dr_resched')
    const res = await post('/booking/bk_dr_resched/reschedule', { token, start: String(NOW + 3 * 86_400_000) })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Please contact the host directly')
    expect((await repos().bookings.byId('bk_dr_resched'))?.status).toBe('confirmed')
  })

  it('refuses a cancel the same way', async () => {
    const token = await seedDrifted('bk_dr_cancel')
    const res = await post('/booking/bk_dr_cancel/cancel', { token })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Please contact the host directly')
    expect((await repos().bookings.byId('bk_dr_cancel'))?.status).toBe('confirmed')
  })
})
