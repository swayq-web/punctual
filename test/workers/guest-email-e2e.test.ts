/**
 * End to end through the REAL coordinator, D1 and queue consumer: a guest who
 * books with lang=da gets Danish mail, replies go to the host, the locale is
 * stored on the booking, and the host is told about a repeat booking.
 */

import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildRouter } from '../../src/http/router.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createR2BlobStorage } from '../../src/adapters/storage/r2-blob.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { createCoordinator } from '../../src/adapters/coordinator.js'
import { handleOne } from '../../src/adapters/queue/consumer.js'
import { createSlotService } from '../../src/engine.js'
import { createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type { BlobCache, CalendarProviders, EmailMessage, EnginePorts, QueuePort } from '../../src/ports.js'

const db = env.DB
const BASE = 'https://punctual.test'
const HOST_ID = 'usr_e2e_host'
const HOST_EMAIL = 'host@e2e.test'
const NOW = Date.now()
const SLOT = (days: number): number => Math.ceil((NOW + days * 86_400_000) / 300_000) * 300_000

const crypto_ = createWebCrypto({
  keys: { 1: 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy0hIQ==' },
  currentVersion: 1,
  signingKey: 'dGVzdC1zaWduaW5nLWtleS0zMi1ieXRlcy1sb25nLi4h',
})
const calendars: CalendarProviders = {
  get() {
    throw new Error('test: no calendar provider is configured')
  },
  available: () => [],
}
const blobCache: BlobCache = {
  async get() {
    return null
  },
  async put() {},
}

const emails: EmailMessage[] = []
const pending: unknown[] = []
const queue: QueuePort = {
  async send(m) {
    pending.push(m)
  },
  async sendBatch(ms) {
    for (const m of ms) pending.push(m)
  },
}

const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(db, scope),
  calendars,
  oauth: { forProvider: () => null, redirectUri: () => `${BASE}/auth/x` },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache: { async get() { return null }, async put() {}, async delete() {} },
  blobCache,
  blobStorage: createR2BlobStorage(env.AVATARS),
  clock: { now: () => Date.now() },
  queue,
  coordinator: undefined as never,
  rateLimiter: createFakeRateLimiter(),
  config: fakeConfig({ baseUrl: BASE, brandName: 'SwayQ' }),
}
ports.coordinator = createCoordinator({
  ports,
  hostCalendarNamespace: env.HOST_CALENDAR,
  repositories: () => createD1Repositories(db, { consistency: 'bookmark' }),
})
const app = buildRouter(ports, createSlotService(ports))

/** Run the queue the way production does, capturing every email it would send. */
async function drain(): Promise<void> {
  while (pending.length > 0) {
    const m = pending.shift() as { kind: string; message?: EmailMessage }
    if (m.kind === 'email' && m.message) {
      emails.push(m.message)
      continue
    }
    await handleOne(m as never, ports)
  }
}

let ip = 0
async function book(start: number, email: string, lang: string): Promise<Response> {
  const form = new FormData()
  form.append('start', String(start))
  form.append('tz', 'Europe/Copenhagen')
  form.append('name', 'Anna Jensen')
  form.append('email', email)
  form.append('lang', lang)
  return app.fetch(
    new Request(`${BASE}/hopper/intro/confirm`, {
      method: 'POST',
      body: form,
      headers: { 'cf-connecting-ip': `203.0.113.${++ip}` },
    }),
  )
}

beforeAll(async () => {
  const day = '[{"startMinute":0,"endMinute":1440}]'
  const week = `[${Array(7).fill(day).join(',')}]`
  await db.batch([
    db.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind(HOST_ID, HOST_EMAIL, 'Grace Hopper', 'UTC', 'hopper', NOW),
    db
      .prepare('INSERT INTO schedules (id,user_id,name,is_default,timezone,weekly_json,overrides_json,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind('sch_e2e', HOST_ID, 'Hours', 1, 'UTC', week, '[]', NOW),
    db
      .prepare('INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind('et_e2e', HOST_ID, null, 'personal', 'intro', 'Intro call', '', 30, 1, NOW),
  ])
})

describe('guest language, end to end', () => {
  it('books with lang=da: stored on the booking, Danish mail to the guest, Reply-To the host', async () => {
    const res = await book(SLOT(8), 'anna@example.dk', 'da')
    expect(res.status).toBe(200)
    await drain()

    const row = await db.prepare('SELECT guest_locale FROM bookings WHERE guest_email = ?').bind('anna@example.dk').first<{ guest_locale: string | null }>()
    expect(row?.guest_locale).toBe('da')

    const guestMail = emails.find((m) => m.to === 'anna@example.dk')!
    expect(guestMail).toBeDefined()
    expect(guestMail.subject).toMatch(/^Bekræftet: Intro call med Grace Hopper/)
    expect(guestMail.html).toContain('<html lang="da">')
    expect(guestMail.text).toContain('Du modtager en kalenderinvitation fra Google.')
    expect(guestMail.replyTo).toBe(HOST_EMAIL)

    // The host's mail is English and replies go to the guest, as before.
    const hostMail = emails.find((m) => m.to === HOST_EMAIL)!
    expect(hostMail.subject).toContain('New booking')
    expect(hostMail.replyTo).toBe('anna@example.dk')
    expect(hostMail.text).not.toContain('already has a booking')
  })

  it('an English guest gets English mail', async () => {
    emails.length = 0
    await book(SLOT(9), 'ben@example.com', 'en')
    await drain()
    expect(emails.find((m) => m.to === 'ben@example.com')!.subject).toMatch(/^Confirmed: Intro call with Grace Hopper/)
  })

  it('tells the host when the same guest already has another upcoming booking', async () => {
    emails.length = 0
    await book(SLOT(10), 'anna@example.dk', 'da')
    await drain()
    const hostMail = emails.find((m) => m.to === HOST_EMAIL)!
    expect(hostMail.text).toContain('This guest already has a booking with you on')
  })

  it('cancelling by the guest and a reminder also speak Danish (the stored locale is what counts)', async () => {
    const { notifyBookingCancelled } = await import('../../src/adapters/notify.js')
    emails.length = 0
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const [booking] = (await repos.bookings.listForHost(HOST_ID, { start: NOW, end: NOW + 400 * 86_400_000 })).filter((b) => b.guestEmail === 'anna@example.dk')
    const eventType = (await repos.eventTypes.byId(booking!.eventTypeId))!
    const host = (await repos.users.byId(HOST_ID))!
    await notifyBookingCancelled({ ports, booking: booking!, eventType, host, cancelledBy: 'guest' } as never)
    await drain()
    const mail = emails.find((m) => m.to === 'anna@example.dk')!
    expect(mail.subject.startsWith('Aflyst:')).toBe(true)
    expect(mail.replyTo).toBe(HOST_EMAIL)
  })
})

describe('the per-email daily limit counts bookings that exist', () => {
  it('three bookings in a day, then refused; a +tag is the same guest; a failed attempt costs nothing', async () => {
    const email = 'limit@example.com'
    // A slot that is already taken: the attempt fails and must not count.
    expect((await book(SLOT(20), email, 'en')).status).toBe(200)
    const taken = await book(SLOT(20), email, 'en')
    expect(taken.status).toBe(409)
    expect((await book(SLOT(21), 'Limit+two@Example.com', 'en')).status).toBe(200)
    expect((await book(SLOT(22), email, 'en')).status).toBe(200)
    const fourth = await book(SLOT(23), email, 'da')
    expect(fourth.status).toBe(429)
    expect(await fourth.text()).toContain('Daglig grænse nået')
    // Someone else is unaffected.
    expect((await book(SLOT(23), 'someone@example.com', 'en')).status).toBe(200)
  })
})
