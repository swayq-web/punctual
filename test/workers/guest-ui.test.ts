/**
 * The guest-facing surface of the SwayQ deployment, through the real router
 * and a real D1: language (en/da), the SwayQ skin, manage-page hardening,
 * Turnstile, and the
 * upstream surfaces that are switched off.
 *
 * The coordinator is a recording fake: this file is about what the guest
 * route does BEFORE and AFTER a booking, not about the booking transaction
 * (booking-race.test.ts owns that).
 */

import { env } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildRouter } from '../../src/http/router.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createR2BlobStorage } from '../../src/adapters/storage/r2-blob.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { createSlotService } from '../../src/engine.js'
import { issueManageToken } from '../../src/core/domain/auth-flows.js'
import { createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type {
  BlobCache,
  BookingAttempt,
  BookingOutcome,
  CalendarProviders,
  EnginePorts,
  HostCoordinator,
  QueuePort,
} from '../../src/ports.js'
import type { Booking } from '../../src/core/domain/types.js'

const db = env.DB
const BASE = 'https://punctual.test'
const NOW = Date.now()
const HOST_ID = 'usr_gui_host'
const ET_ID = 'et_gui_intro'
const BOOKING_ID = 'bk_gui_manage'
const START = Math.ceil((NOW + 7 * 86_400_000) / 300_000) * 300_000

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
const queue: QueuePort = { async send() {}, async sendBatch() {} }

const attempts: BookingAttempt[] = []
const coordinator: HostCoordinator = {
  async book(_hostId: string, request: BookingAttempt): Promise<BookingOutcome> {
    attempts.push(request)
    const booking: Booking = {
      id: `bk_${attempts.length}`,
      eventTypeId: request.eventTypeId,
      hostUserId: HOST_ID,
      hostUserIds: [HOST_ID],
      guestName: request.guestName,
      guestEmail: request.guestEmail,
      guestTimezone: request.guestTimezone,
      startUtc: request.start,
      endUtc: request.end,
      localDate: '2030-01-01',
      status: 'confirmed',
      answers: request.answers,
      externalEventIds: {},
      conferenceUrl: null,
      rescheduleOf: null,
      rescheduledTo: null,
      manageTokenHash: 'h',
      cancelledAt: null,
      createdAt: NOW,
    }
    return { ok: true, booking, manageToken: 'tok_secret' }
  },
  async hold() {
    return null
  },
  async releaseHold() {},
} as unknown as HostCoordinator

const limiter = createFakeRateLimiter()
const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(db, scope),
  calendars,
  oauth: { forProvider: () => null, redirectUri: (name, purpose) => `${BASE}/auth/${name}/callback?purpose=${purpose}` },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache: { async get() { return null }, async put() {}, async delete() {} },
  blobCache,
  blobStorage: createR2BlobStorage(env.AVATARS),
  clock: { now: () => Date.now() },
  queue,
  coordinator,
  rateLimiter: limiter,
  config: fakeConfig({ baseUrl: BASE, brandName: 'SwayQ' }),
}

const app = buildRouter(ports, createSlotService(ports))

function get(path: string, headers: Record<string, string> = {}, e: Record<string, unknown> = {}): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { headers }), e))
}

// Each POST comes from its own address: the per-IP abuse limit (10 an hour) is not what these tests are about.
let ipCounter = 0

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}, e: Record<string, unknown> = {}): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const ip = headers['cf-connecting-ip'] ?? `198.51.100.${++ipCounter}`
  return Promise.resolve(
    app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { ...headers, 'cf-connecting-ip': ip } }), e),
  )
}

const bookingFields = (email: string, extra: Record<string, string> = {}): Record<string, string> => ({
  start: String(START),
  tz: 'Europe/Copenhagen',
  name: 'Gæst Gustav',
  email,
  ...extra,
})

let manageToken = ''

beforeAll(async () => {
  await db.batch([
    db
      .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
      .bind(HOST_ID, 'host@gui.test', 'Grace Hopper', 'Europe/Copenhagen', 'grace', NOW),
    db
      .prepare(
        'INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(ET_ID, HOST_ID, null, 'personal', 'intro', 'Intro call', 'A short chat.', 30, 1, NOW),
  ])
  const issued = await issueManageToken({ crypto: crypto_ }, { id: BOOKING_ID, startUtc: START }, 'manage')
  manageToken = issued.token
  const booking: Booking = {
    id: BOOKING_ID,
    eventTypeId: ET_ID,
    hostUserId: HOST_ID,
    hostUserIds: [HOST_ID],
    guestName: 'Gæst Gustav',
    guestEmail: 'gustav@example.com',
    guestTimezone: 'Europe/Copenhagen',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2030-01-01',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: issued.tokenHash,
    cancelledAt: null,
    createdAt: NOW,
  }
  await createD1Repositories(db, { consistency: 'bookmark' }).bookings.createWithLocks(booking, [])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
describe('language', () => {
  it('Accept-Language: da renders the booking page in Danish with <html lang="da">', async () => {
    const res = await get('/grace/intro', { 'accept-language': 'da-DK,da;q=0.9,en;q=0.5' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<html lang="da">')
    expect(html).toContain('Vælg en dag')
    expect(html).toContain('Tidszone')
    expect(html).toContain('30 min.')
    expect(html).not.toContain('Choose a day')
  })

  it('defaults to English, and ?lang= beats Accept-Language and is remembered in a cookie', async () => {
    const en = await (await get('/grace/intro')).text()
    expect(en).toContain('<html lang="en">')
    expect(en).toContain('Choose a day')

    const res = await get('/grace/intro?lang=en', { 'accept-language': 'da' })
    expect(await res.text()).toContain('<html lang="en">')
    expect(res.headers.get('set-cookie')).toContain('pu_lang=en')
    expect(res.headers.get('vary')).toContain('Accept-Language')
  })

  it('the cookie beats Accept-Language, and an unsupported ?lang= is ignored', async () => {
    const viaCookie = await (await get('/grace/intro', { cookie: 'pu_lang=da', 'accept-language': 'en' })).text()
    expect(viaCookie).toContain('<html lang="da">')
    const bogus = await get('/grace/intro?lang=xx', { 'accept-language': 'da' })
    expect(await bogus.text()).toContain('<html lang="da">')
    expect(bogus.headers.get('set-cookie')).toBeNull()
  })

  it('shows a visible EN/DA toggle that links to the other language, and carries ?lang= on internal links', async () => {
    const html = await (await get('/grace/intro?lang=da')).text()
    expect(html).toMatch(/<nav class="pu-lang"[^>]*>.*<a href="\/grace\/intro\?lang=en"/s)
    expect(html).toContain('aria-current="true">DA<')
    // An explicit choice rides on the month links, so it survives where a cookie cannot (an iframe).
    expect(html).toMatch(/href="\/grace\/intro\?month=\d{4}-\d{2}&amp;tz=[^"]*&amp;lang=da"/)
  })

  it('wears the SwayQ wordmark (lowercase, period same colour) and not the upstream one', async () => {
    const html = await (await get('/grace/intro')).text()
    expect(html).toContain('swayq<span>.</span>')
    expect(html).not.toContain('punctual<span>:</span>')
    expect(html).toContain('/fonts/poppins-400.woff2')
    expect(html).toContain('<meta name="color-scheme" content="light">')
  })

  it('the confirm page is Danish and names the timezone', async () => {
    const res = await get(`/grace/intro/confirm?start=${START}&tz=Europe%2FCopenhagen`, { 'accept-language': 'da' })
    const html = await res.text()
    expect(html).toContain('Bekræft din booking')
    expect(html).not.toContain('kolleger')
    expect(html).toContain('Du modtager en kalenderinvitation fra Google.')
    expect(html).toMatch(/Europe\/Copenhagen \(GMT\+[12]\)/)
    expect(html).not.toContain('challenges.cloudflare.com')
  })

  it('no em dash appears in any rendered guest page', async () => {
    for (const lang of ['en', 'da']) {
      const pages = [
        await (await get(`/grace/intro?lang=${lang}`)).text(),
        await (await get(`/grace/intro/confirm?start=${START}&tz=UTC&lang=${lang}`)).text(),
        await (await get(`/grace/nope?lang=${lang}`)).text(),
      ]
      // Visible text only: upstream's inline stylesheet and HTML comments carry em dashes.
      for (const html of pages) expect(html.replace(/<style>[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '')).not.toContain(String.fromCharCode(0x2014))
    }
  })
})

// ---------------------------------------------------------------------------
describe('booking POST', () => {
  it('passes the locale through, and answers in Danish', async () => {
    attempts.length = 0
    const res = await post(
      `/grace/intro/confirm`,
      bookingFields('anna@example.com', {
        lang: 'da',
      }),
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Du er booket')
    expect(html).toContain('Flyt eller aflys')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.guestLocale).toBe('da')
    // The page links to a credential: never cached, never indexed, no referrer.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
  })

  it('validation errors are Danish when the guest is', async () => {
    const res = await post(`/grace/intro/confirm`, { ...bookingFields('x'), name: '', lang: 'da' })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('Skriv dit navn')
    expect(html).toContain('Skriv en gyldig e-mailadresse')
  })

})

// ---------------------------------------------------------------------------
describe('Turnstile', () => {
  const siteverify = (success: boolean) =>
    vi.fn(async (_url: unknown, _init?: unknown) => new Response(JSON.stringify({ success }), { status: 200 }))

  it('required with no secret: refused (fails closed), nothing booked', async () => {
    attempts.length = 0
    const res = await post(`/grace/intro/confirm`, bookingFields('ts1@example.com'), {}, { TURNSTILE_REQUIRED: '1' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('We could not verify that you are a person')
    expect(attempts).toHaveLength(0)
  })

  it('a secret is set but the token is missing or rejected: refused', async () => {
    attempts.length = 0
    const stub = siteverify(false)
    vi.stubGlobal('fetch', stub)
    const e = { TURNSTILE_SECRET: 's3cret', TURNSTILE_REQUIRED: '1' }

    const missing = await post(`/grace/intro/confirm`, bookingFields('ts2@example.com'), {}, e)
    expect(missing.status).toBe(400)
    expect(stub).not.toHaveBeenCalled() // no token, no siteverify call

    const rejected = await post(
      `/grace/intro/confirm`,
      bookingFields('ts3@example.com', { 'cf-turnstile-response': 'bad-token' }),
      {},
      e,
    )
    expect(rejected.status).toBe(400)
    expect(stub).toHaveBeenCalledTimes(1)
    expect(attempts).toHaveLength(0)
  })

  it('a valid token books, and siteverify gets the secret and the token', async () => {
    attempts.length = 0
    const stub = siteverify(true)
    vi.stubGlobal('fetch', stub)
    const res = await post(
      `/grace/intro/confirm`,
      bookingFields('ts4@example.com', { 'cf-turnstile-response': 'good-token' }),
      { 'cf-connecting-ip': '203.0.113.9' },
      { TURNSTILE_SECRET: 's3cret', TURNSTILE_REQUIRED: '1' },
    )
    expect(res.status).toBe(200)
    expect(attempts).toHaveLength(1)
    const [url, init] = stub.mock.calls[0]! as [string, { body: URLSearchParams }]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(init.body.get('secret')).toBe('s3cret')
    expect(init.body.get('response')).toBe('good-token')
    expect(init.body.get('remoteip')).toBe('203.0.113.9')
  })

  it('siteverify unreachable: fails closed', async () => {
    attempts.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const res = await post(
      `/grace/intro/confirm`,
      bookingFields('ts5@example.com', { 'cf-turnstile-response': 'tok' }),
      {},
      { TURNSTILE_SECRET: 's3cret' },
    )
    expect(res.status).toBe(400)
    expect(attempts).toHaveLength(0)
  })

  it('skips only when NOT required and no secret (local dev)', async () => {
    attempts.length = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(`/grace/intro/confirm`, bookingFields('ts6@example.com'))
    expect(res.status).toBe(200)
    expect(attempts).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Turnstile skipped'))
    warn.mockRestore()
  })

  it('renders the widget and its script only on the confirm form, and only with a site key', async () => {
    const withKey = await (await get(`/grace/intro/confirm?start=${START}&tz=UTC`, {}, { TURNSTILE_SITE_KEY: '0xKEY' })).text()
    expect(withKey).toContain('class="cf-turnstile pu-turnstile" data-sitekey="0xKEY"')
    expect(withKey).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js')
    const booking = await (await get('/grace/intro', {}, { TURNSTILE_SITE_KEY: '0xKEY' })).text()
    expect(booking).not.toContain('challenges.cloudflare.com')
  })
})

// ---------------------------------------------------------------------------
describe('manage pages carry a credential', () => {
  it('send noindex, no-referrer and no-store, and name no third-party origin', async () => {
    const res = await get(`/booking/${BOOKING_ID}?token=${encodeURIComponent(manageToken)}`, { 'accept-language': 'da' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toContain('<meta name="referrer" content="no-referrer">')
    expect(html).toContain('<html lang="da">')
    expect(html).toContain('Aflys bookingen')
    expect(html).not.toMatch(/\b(?:src|href|action)="https?:\/\//)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('challenges.cloudflare.com')
    // The token is in the page, which is exactly why the headers above matter.
    expect(html).toContain('name="token"')
  })

  it('an invalid link gets the same headers and a Danish explanation', async () => {
    const res = await get(`/booking/${BOOKING_ID}?token=garbage&lang=da`)
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    const html = await res.text()
    expect(html).toContain('Linket er ugyldigt')
  })

  it('cancelling answers in the guest language with the same headers', async () => {
    const res = await post(`/booking/${BOOKING_ID}/cancel`, { token: manageToken, lang: 'da' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Bookingen er aflyst')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

// ---------------------------------------------------------------------------
describe('surfaces SwayQ switches off', () => {
  it.each([
    ['GET', '/mcp'],
    ['POST', '/mcp'],
    ['GET', `/avatars/${'a'.repeat(64)}-thumb.webp`],
    ['GET', '/dashboard/insights'],
    ['GET', '/dashboard/api-keys'],
    ['POST', '/dashboard/api-keys'],
    ['POST', '/dashboard/settings/avatar'],
    ['POST', '/dashboard/event-types/et_x/logo'],
    ['GET', '/auth/microsoft/start?purpose=calendar'],
    ['GET', '/auth/microsoft/callback/calendar'],
  ])('%s %s is a 404', async (method, path) => {
    const res = await Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method })))
    expect(res.status).toBe(404)
  })

  it.each([
    ['GET', '/dashboard/api%2Dkeys'],
    ['GET', '/auth/%6Dicrosoft/start?purpose=calendar'],
    ['GET', `/%61vatars/${'a'.repeat(64)}-thumb.webp`],
    ['GET', '/dashboard/%69nsights'],
    ['POST', '/dashboard/settings/%61vatar'],
  ])('%s %s: percent-encoding does not get around the switch', async (method, path) => {
    const res = await Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method })))
    expect(res.status).toBe(404)
  })

  it('a Telegram channel posted to an encoded endpoint is still refused', async () => {
    const res = await post('/dashboard/notificat%69ons', { kind: 'telegram', bot_token: 'x', chat_id: '1' })
    expect(res.status).toBe(404)
  })

  it('a Telegram channel cannot be created; the same endpoint still serves Slack (auth decides, not a 404)', async () => {
    const telegram = await post('/dashboard/notifications', { kind: 'telegram', bot_token: 'x', chat_id: '1' })
    expect(telegram.status).toBe(404)
    const slack = await post('/dashboard/notifications', { kind: 'slack' })
    expect(slack.status).not.toBe(404)
  })

  it('team scheduling is blocked on the server, not just hidden: teams, team-owned event types in the dashboard and the API', async () => {
    expect((await get('/dashboard/teams')).status).toBe(404)
    expect((await post('/dashboard/teams', { name: 'Crew' })).status).toBe(404)
    expect((await post('/dashboard/teams/t1/members', { email: 'a@b.c' })).status).toBe(404)
    expect((await post('/dashboard/event-types', { title: 'X', owner: 'team_1', schedulingType: 'collective' })).status).toBe(404)
    expect((await post('/dashboard/event-types/et_1', { title: 'X', owner: 'team_1' })).status).toBe(404)
    const json = (method: string, path: string, body: unknown) =>
      Promise.resolve(
        app.fetch(new Request(`${BASE}${path}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })),
      )
    expect((await json('POST', '/api/v1/event-types', { title: 'X', ownerTeamId: 'team_1' })).status).toBe(404)
    // A personal event type is not caught by the switch (auth decides: no key, so 401 and not 404).
    expect((await json('POST', '/api/v1/event-types', { title: 'X', ownerTeamId: null })).status).not.toBe(404)
    expect((await post('/dashboard/event-types', { title: 'X', owner: '' })).status).not.toBe(404)
  })

  it('the dashboard does not offer the switched-off entry points', async () => {
    // Pages render for a signed-in host; see the core tests for the nav. Here: the login page is not affected.
    const res = await get('/login')
    expect(res.status).toBe(200)
  })
})
