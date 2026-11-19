/**
 * SwayQ's deployment shows nothing of the upstream project.
 *
 * Built from the `[vars]` of the wrangler configs SwayQ actually deploys
 * (`wrangler.production.toml`, `wrangler.staging.toml`), through the real
 * router and a real D1:
 *
 *  - `/` never serves the upstream landing: signed out it redirects to
 *    `/login`, signed in to `/dashboard`;
 *  - `/docs*` and `/calendly-alternative` do not exist;
 *  - no guest page, staff page or mail contains "punctual", "github" or
 *    "Star on" (case-insensitive).
 *
 * A new page or mail belongs in the lists below. The only text let through is
 * `ALLOWED`, each entry a machine identifier no person reads.
 */

import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import productionToml from '../../wrangler.production.toml?raw'
import stagingToml from '../../wrangler.staging.toml?raw'
import templateToml from '../../wrangler.toml?raw'

import { buildRouter } from '../../src/http/router.js'
import { EMBED_MESSAGE_TYPE } from '../../src/http/embed.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createR2BlobStorage } from '../../src/adapters/storage/r2-blob.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { createSlotService } from '../../src/engine.js'
import { issueManageToken } from '../../src/core/domain/auth-flows.js'
import { SESSION_ABSOLUTE_TTL_MS, SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../../src/core/domain/auth-service.js'
import { HOME_MODE } from '../../src/core/domain/home.js'
import {
  bookingCancelled,
  bookingConfirmationForGuest,
  bookingConfirmationForHost,
  bookingReminder,
  bookingRescheduled,
  dailyDigestEmail,
  hostAddedEmail,
  type BookingEmailContext,
} from '../../src/core/email-templates.js'
import { parseSwitch } from '../../src/swayq-surfaces.js'
import { createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type { BookingAttempt, BookingOutcome, EngineConfig, EnginePorts, HostCoordinator } from '../../src/ports.js'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'

const db = env.DB
const NOW = Date.now()
const START = Math.ceil((NOW + 7 * 86_400_000) / 300_000) * 300_000
const STAFF_ID = 'usr_nou_staff'
const ET_ID = 'et_nou_intro'
const BOOKING_ID = 'bk_nou_manage'

const FORBIDDEN = /punctual|github|star on/i

/**
 * Machine identifiers that carry the upstream name and are not shown to
 * anyone. Removed from the output before it is searched.
 *  - the embed resize message type: the postMessage protocol between
 *    `/embed.js` and the embedded page, which must match on both ends.
 */
const ALLOWED: readonly string[] = [EMBED_MESSAGE_TYPE]

function leak(output: string): string | null {
  let text = output
  for (const token of ALLOWED) text = text.split(token).join('')
  const hit = FORBIDDEN.exec(text)
  return hit ? text.slice(Math.max(0, hit.index - 80), hit.index + 80) : null
}

/** The `[vars]` table of a wrangler config: `KEY = "value"` lines, comments dropped. */
function wranglerVars(toml: string): Record<string, string> {
  const start = toml.indexOf('\n[vars]')
  if (start < 0) throw new Error('no [vars] table')
  const vars: Record<string, string> = {}
  for (const line of toml.slice(start + 7).split('\n')) {
    if (/^\s*\[/.test(line)) break
    const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line)
    if (m) vars[m[1]!] = m[2]!
  }
  return vars
}

/** The same mapping `createPorts` (src/index.ts) applies to the deployment's vars. */
function configFrom(vars: Record<string, string>): EngineConfig {
  return fakeConfig({
    baseUrl: vars['BASE_URL']!,
    brandName: vars['BRAND_NAME']!,
    legalOperator: vars['LEGAL_OPERATOR']!,
    supportEmail: vars['SUPPORT_EMAIL']!,
    fromEmail: vars['FROM_EMAIL']!,
    fromName: vars['FROM_NAME']!,
    emailDelivery: 'resend',
    upstreamPages: parseSwitch(vars['UPSTREAM_PAGES']),
  })
}

const crypto_ = createWebCrypto({
  keys: { 1: 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy0hIQ==' },
  currentVersion: 1,
  signingKey: 'dGVzdC1zaWduaW5nLWtleS0zMi1ieXRlcy1sb25nLi4h',
})

const coordinator = {
  async book(_hostId: string, request: BookingAttempt): Promise<BookingOutcome> {
    return { ok: true, booking: bookingRow({ id: 'bk_nou_new', startUtc: request.start, endUtc: request.end }), manageToken: 'tok' }
  },
  async hold() {
    return null
  },
  async releaseHold() {},
} as unknown as HostCoordinator

function bookingRow(patch: Partial<Booking> = {}): Booking {
  return {
    id: BOOKING_ID,
    eventTypeId: ET_ID,
    hostUserId: STAFF_ID,
    hostUserIds: [STAFF_ID],
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
    manageTokenHash: 'h',
    cancelledAt: null,
    createdAt: NOW,
    ...patch,
  }
}

function deployment(config: EngineConfig) {
  const email = createFakeEmailSender()
  const ports: EnginePorts = {
    repositories: (scope) => createD1Repositories(db, scope),
    // No calendar credentials: the Calendars page renders its "ask your admin" notice.
    calendars: {
      get() {
        throw new Error('test: no calendar provider is configured')
      },
      available: () => [],
    },
    oauth: { forProvider: () => null, redirectUri: (name, purpose) => `${config.baseUrl}/auth/${name}/callback?purpose=${purpose}` },
    email,
    crypto: crypto_,
    cache: { async get() { return null }, async put() {}, async delete() {} },
    blobCache: { async get() { return null }, async put() {} },
    blobStorage: createR2BlobStorage(env.AVATARS),
    clock: { now: () => Date.now() },
    queue: { async send() {}, async sendBatch() {} },
    coordinator,
    rateLimiter: createFakeRateLimiter(),
    config,
  }
  const app = buildRouter(ports, createSlotService(ports))
  let ip = 0
  return {
    email,
    get: (path: string, cookie?: string, headers: Record<string, string> = {}): Promise<Response> =>
      Promise.resolve(app.fetch(new Request(`${config.baseUrl}${path}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } }), {})),
    post: (path: string, fields: Record<string, string>): Promise<Response> => {
      const form = new FormData()
      for (const [k, v] of Object.entries(fields)) form.append(k, v)
      return Promise.resolve(
        app.fetch(new Request(`${config.baseUrl}${path}`, { method: 'POST', body: form, headers: { 'cf-connecting-ip': `198.51.100.${++ip}` } }), {}),
      )
    },
  }
}

let staffCookie = ''
let manageToken = ''

beforeAll(async () => {
  await db.batch([
    db
      .prepare('INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(STAFF_ID, 'staff@swayq.com', 'Søren Staff', 'Europe/Copenhagen', 'soren', 'admin', NOW),
    db
      .prepare(
        'INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(ET_ID, STAFF_ID, null, 'personal', 'intro', 'Intro call', 'A short chat.', 30, 1, NOW),
  ])
  const token = crypto_.randomToken(32)
  await db
    .prepare('INSERT INTO sessions (id_hash,user_id,expires_at,absolute_expires_at,bookmark,created_at) VALUES (?,?,?,?,?,?)')
    .bind(await crypto_.hash(token), STAFF_ID, NOW + SESSION_TTL_MS, NOW + SESSION_ABSOLUTE_TTL_MS, null, NOW)
    .run()
  staffCookie = `${SESSION_COOKIE_NAME}=${token}`

  const issued = await issueManageToken({ crypto: crypto_ }, { id: BOOKING_ID, startUtc: START }, 'manage')
  manageToken = issued.token
  await createD1Repositories(db, { consistency: 'bookmark' }).bookings.createWithLocks(
    bookingRow({ manageTokenHash: issued.tokenHash }),
    [],
  )
})

const SWAYQ_CONFIGS = [
  ['wrangler.production.toml', productionToml],
  ['wrangler.staging.toml', stagingToml],
] as const

describe.each(SWAYQ_CONFIGS)('SwayQ deployment (%s)', (_file, toml) => {
  const vars = wranglerVars(toml)
  const config = configFrom(vars)
  const site = deployment(config)

  it('is configured as SwayQ with the upstream pages off', () => {
    expect(vars['BRAND_NAME']).toBe('SwayQ')
    expect(config.upstreamPages).toBe(false)
  })

  describe('the root address', () => {
    it('redirects a signed-out visitor to the sign-in page', async () => {
      const res = await site.get('/')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe('')
    })

    it('redirects a signed-in staff member to the dashboard', async () => {
      const res = await site.get('/', staffCookie)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/dashboard')
    })

    it('treats a cookie that matches no session as signed out', async () => {
      const res = await site.get('/', `${SESSION_COOKIE_NAME}=${crypto_.randomToken(32)}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    })

    it('redirects when the stored front-page setting is the landing', async () => {
      await createD1Repositories(db, { consistency: 'bookmark' }).settings.set(HOME_MODE, 'landing', NOW)
      const res = await site.get('/')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    })
  })

  it('shows the booking index, with nothing upstream on it, only when an admin chose "This instance"', async () => {
    const settings = createD1Repositories(db, { consistency: 'bookmark' }).settings
    await settings.set(HOME_MODE, 'index', NOW)
    try {
      const res = await site.get('/')
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('href="/login"')
      expect(leak(html)).toBeNull()
    } finally {
      await settings.set(HOME_MODE, 'landing', NOW)
    }
  })

  it.each(['/docs', '/docs/self-hosting', '/docs/api', '/docs/mcp', '/calendly-alternative', '/%64ocs'])(
    'does not serve the upstream page %s',
    async (path) => {
      const res = await site.get(path)
      expect(res.status).toBe(404)
      expect(leak(await res.text())).toBeNull()
    },
  )

  const day = new Date(START).toISOString().slice(0, 10)
  const GUEST_PAGES: ReadonlyArray<readonly [string, number]> = [
    ['/soren/intro', 200],
    ['/soren/intro?lang=da', 200],
    [`/soren/intro?date=${day}&tz=Europe/Copenhagen`, 200],
    ['/soren/intro?embed=1', 200],
    [`/soren/intro/confirm?start=${START}&tz=Europe/Copenhagen`, 200],
    [`/soren/intro/confirm?start=${START}&tz=Europe/Copenhagen&lang=da`, 200],
    ['/soren/nothing-here', 404],
    ['/nobody', 404],
    ['/booking/bk_nou_manage?token=not-a-token', 400],
    ['/login', 200],
    ['/privacy', 200],
    ['/terms', 200],
    ['/robots.txt', 200],
    ['/embed.js', 200],
    ['/favicon.svg', 200],
    ['/auth/verify?token=not-a-token', 400],
    ['/health', 200],
  ]

  it.each(GUEST_PAGES)('guest page %s names nothing upstream', async (path, status) => {
    const res = await site.get(path)
    expect(res.status).toBe(status)
    const body = await res.text()
    expect(body.length).toBeGreaterThan(0)
    // /health is machine-read (deploy smoke test, monitors); its `service` id stays.
    expect(leak(path === '/health' ? body.replace('"service":"punctual"', '') : body)).toBeNull()
  })

  it('the guest manage page, by its link from mail, names nothing upstream', async () => {
    for (const lang of ['en', 'da']) {
      const res = await site.get(`/booking/${BOOKING_ID}?token=${encodeURIComponent(manageToken)}&lang=${lang}`)
      expect(res.status).toBe(200)
      expect(leak(await res.text())).toBeNull()
    }
  })

  it('the booking confirmation page names nothing upstream', async () => {
    const res = await site.post('/soren/intro/confirm', {
      start: String(START),
      tz: 'Europe/Copenhagen',
      name: 'Gæst Gustav',
      email: 'gustav@example.com',
    })
    expect(res.status).toBe(200)
    expect(leak(await res.text())).toBeNull()
  })

  it('a link preview that cannot be drawn has no image, not the upstream card', async () => {
    // "Søren" is outside the card font's ASCII range, so the card is not rendered.
    const res = await site.get('/og/soren/intro.png')
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
  })

  const STAFF_PAGES = [
    '/dashboard',
    '/dashboard/event-types/new',
    `/dashboard/event-types/${ET_ID}`,
    '/dashboard/bookings',
    `/dashboard/bookings/${BOOKING_ID}`,
    `/dashboard/bookings/${BOOKING_ID}/reschedule`,
    '/dashboard/availability',
    '/dashboard/connections',
    '/dashboard/settings',
    '/dashboard/admin',
  ]

  it.each(STAFF_PAGES)('staff page %s names nothing upstream', async (path) => {
    const res = await site.get(path, staffCookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Sign out')
    expect(leak(html)).toBeNull()
    expect(html).not.toContain('href="/docs')
  })

  it('the dashboard with mail not configured names nothing upstream', async () => {
    const broken = deployment({ ...config, emailDelivery: 'console', emailProblem: 'EMAIL_PROVIDER names resend but RESEND_API_KEY is not set' })
    const html = await (await broken.get('/dashboard', staffCookie)).text()
    expect(html).toContain('Email is not configured')
    expect(leak(html)).toBeNull()
    expect(html).not.toContain('href="/docs')
  })

  it('switched-off staff surfaces answer 404 without naming anything upstream', async () => {
    for (const path of ['/dashboard/api-keys', '/dashboard/insights', '/dashboard/teams', '/mcp']) {
      const res = await site.get(path, staffCookie)
      expect(res.status).toBe(404)
      expect(leak(await res.text())).toBeNull()
    }
  })

  it('the sign-in mail names nothing upstream', async () => {
    const res = await site.post('/login', { email: 'staff@swayq.com', tz: 'Europe/Copenhagen' })
    expect(res.status).toBe(200)
    expect(leak(await res.text())).toBeNull()
    expect(site.email.sent.length).toBe(1)
    const mail = site.email.sent[0]!
    expect(mail.subject).toBe('Sign in to SwayQ')
    expect(leak(`${mail.subject}\n${mail.text}\n${mail.html ?? ''}`)).toBeNull()
  })

  it('booking mail to guests and staff names nothing upstream', () => {
    const host: User = {
      id: STAFF_ID,
      email: 'staff@swayq.com',
      name: 'Søren Staff',
      tz: 'Europe/Copenhagen',
      slug: 'soren',
      avatarKey: null,
      company: null,
      jobTitle: null,
      companyUrl: null,
      role: 'admin',
      createdAt: 0,
    }
    const eventType: EventType = {
      id: ET_ID,
      ownerUserId: STAFF_ID,
      ownerTeamId: null,
      schedulingType: 'personal',
      slug: 'intro',
      title: 'Intro call',
      description: 'A short chat.',
      durationMinutes: 30,
      slotIntervalMinutes: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPerDay: null,
      locationType: 'google_meet',
      locationValue: null,
      questions: [],
      active: true,
      createdAt: 0,
      scheduleId: null,
    }
    const base = config.baseUrl
    const ctx: BookingEmailContext = {
      booking: bookingRow(),
      eventType,
      host,
      brandName: config.brandName,
      rescheduleUrl: `${base}/booking/${BOOKING_ID}?token=t&action=reschedule`,
      cancelUrl: `${base}/booking/${BOOKING_ID}?token=t&action=cancel`,
      bookingUrl: `${base}/dashboard/bookings/${BOOKING_ID}`,
      supportEmail: config.supportEmail,
    }
    const previous = { startUtc: START - 86_400_000, endUtc: START - 86_400_000 + 30 * 60_000 }
    const mails = [
      bookingConfirmationForGuest(ctx),
      bookingConfirmationForHost(ctx),
      bookingRescheduled({ ...ctx, audience: 'guest', previous }),
      bookingRescheduled({ ...ctx, audience: 'host', previous }),
      bookingCancelled({ ...ctx, audience: 'guest', cancelledBy: 'host', reason: 'Something came up' }),
      bookingCancelled({ ...ctx, audience: 'host', cancelledBy: 'guest', reason: 'Something came up' }),
      bookingReminder({ ...ctx, audience: 'guest', when: '24h' }),
      bookingReminder({ ...ctx, audience: 'host', when: '1h' }),
      hostAddedEmail({
        brandName: config.brandName,
        hostName: host.name,
        eventTitle: eventType.title,
        teamName: 'Partnerships',
        schedulingType: 'round_robin',
        required: true,
        scheduleName: null,
        editorName: 'Jakob',
        availabilityUrl: `${base}/dashboard/availability`,
        supportEmail: config.supportEmail,
      }),
      dailyDigestEmail({
        brandName: config.brandName,
        supportEmail: config.supportEmail,
        host,
        date: '2030-01-01',
        meetings: [{ booking: bookingRow(), eventType, coHosts: [] }],
        dashboardUrl: `${base}/dashboard/bookings`,
      }),
    ]
    for (const mail of mails) {
      expect(mail.subject.length).toBeGreaterThan(0)
      expect(leak(`${mail.subject}\n${mail.text}\n${mail.html ?? ''}`)).toBeNull()
    }
  })
})

describe('with UPSTREAM_PAGES on (wrangler.toml, the upstream template)', () => {
  const vars = wranglerVars(templateToml)
  const site = deployment(fakeConfig({ upstreamPages: parseSwitch(vars['UPSTREAM_PAGES']) }))

  it('the template turns the switch on', () => {
    expect(vars['UPSTREAM_PAGES']).toBe('1')
  })

  it('still serves the upstream landing at / and the docs', async () => {
    const res = await site.get('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Scheduling that shows up on time')
    expect((await site.get('/docs')).status).toBe(200)
    expect((await site.get('/calendly-alternative')).status).toBe(200)
  })

  it('the guard itself catches the upstream pages', async () => {
    expect(leak(await (await site.get('/')).text())).not.toBeNull()
    expect(leak(await (await site.get('/login')).text())).not.toBeNull()
  })
})

describe('UPSTREAM_PAGES parsing', () => {
  it('is on only for "1" and "true"', () => {
    expect(parseSwitch('1')).toBe(true)
    expect(parseSwitch('TRUE')).toBe(true)
    for (const off of [undefined, null, '', '0', 'false', 'off', 'yes']) expect(parseSwitch(off)).toBe(false)
  })
})
