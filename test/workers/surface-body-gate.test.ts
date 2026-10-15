/**
 * The body gate for switched-off surfaces (src/http/router.ts, SWA-1290):
 * a Telegram channel and a team-owned event type are refused by what the
 * body says, so the gate must read the body the way the handler will, and
 * must refuse a body it cannot read. Runs with the default SwayQ flags (no
 * surface switched back on), unlike channels.test.ts.
 *
 * The gate runs before auth, so no session is needed: 404 means the gate
 * refused, anything else means the request got past it.
 */

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { buildRouter } from '../../src/http/router.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { createSlotService } from '../../src/engine.js'
import { createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type { BlobCache, CalendarProviders, EnginePorts, HostCoordinator, QueuePort } from '../../src/ports.js'

const BASE = 'https://punctual.test'
const material = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)))
const crypto_ = createWebCrypto({ keys: { 1: material }, currentVersion: 1, signingKey: material })
const calendars: CalendarProviders = {
  get() {
    throw new Error('none')
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
const coordinator = new Proxy({} as HostCoordinator, {
  get: () => () => {
    throw new Error('not stubbed')
  },
})
const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(env.DB, scope),
  calendars,
  oauth: { forProvider: () => null, redirectUri: () => `${BASE}/x` },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache: { async get() { return null }, async put() {}, async delete() {} },
  blobCache,
  blobStorage: { async put() {}, async get() { return null }, async delete() {} } as never,
  clock: { now: () => Date.now() },
  queue,
  coordinator,
  rateLimiter: createFakeRateLimiter(),
  config: fakeConfig({ baseUrl: BASE }),
}
const app = buildRouter(ports, createSlotService(ports))

const TELEGRAM = 'kind=telegram&chat_id=-100123&events=booking.created'

function post(path: string, body: BodyInit | null, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (contentType) headers['content-type'] = contentType
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body, headers })))
}

describe('surface body gate', () => {
  it('refuses the Content-Type parameter probe (urlencoded body, "json" in a parameter)', async () => {
    const res = await post('/dashboard/notifications', TELEGRAM, 'application/x-www-form-urlencoded; x=json')
    expect(res.status).toBe(404)
  })

  it('refuses a plain urlencoded telegram channel', async () => {
    expect((await post('/dashboard/notifications', TELEGRAM, 'application/x-www-form-urlencoded')).status).toBe(404)
  })

  it('refuses a multipart telegram channel, and a multipart one with "json" in a parameter', async () => {
    const form = new FormData()
    form.append('kind', 'telegram')
    form.append('chat_id', '-100123')
    expect((await post('/dashboard/notifications', form)).status).toBe(404)

    const boundary = 'xjsonx'
    const raw = `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\ntelegram\r\n--${boundary}--\r\n`
    const type = `multipart/form-data; boundary=${boundary}; note=json`
    expect((await post('/dashboard/notifications', raw, type)).status).toBe(404)
  })

  it('refuses a JSON telegram channel and a +json one', async () => {
    const body = JSON.stringify({ kind: 'telegram' })
    expect((await post('/dashboard/notifications', body, 'application/json')).status).toBe(404)
    expect((await post('/dashboard/notifications', body, 'application/vnd.api+json')).status).toBe(404)
  })

  it('refuses a body it cannot parse', async () => {
    expect((await post('/dashboard/notifications', '{not json', 'application/json')).status).toBe(404)
    expect((await post('/dashboard/notifications', 'kind=telegram', 'text/plain')).status).toBe(404)
    expect((await post('/dashboard/notifications', null)).status).toBe(404)
  })

  it('refuses a team-owned event type through the API, also with a mislabelled body', async () => {
    const body = JSON.stringify({ title: 'x', ownerTeamId: 'team_1' })
    expect((await post('/api/v1/event-types', body, 'application/json')).status).toBe(404)
    expect((await post('/api/v1/event-types', body, 'application/x-www-form-urlencoded; x=json')).status).toBe(404)
  })

  it('lets a permitted channel past the gate (control: not a blanket 404)', async () => {
    const slack = 'kind=slack&webhook_url=https%3A%2F%2Fhooks.slack.com%2Fservices%2FT0ABC%2FB0DEF%2Fxyz'
    const res = await post('/dashboard/notifications', slack, 'application/x-www-form-urlencoded')
    expect(res.status).not.toBe(404)
  })
})
