import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker, { InternalApi } from '../../src/index.js'
import type { InternalEnv } from '../../src/internal/entrypoint.js'

/**
 * The `InternalApi` named entrypoint under the real Workers runtime (SWA-1289).
 *
 * The service logic is covered in test/core/internal-api.test.ts; this file
 * proves the WIRING: the class is a real WorkerEntrypoint built from the real
 * D1-backed ports, the token gate runs before anything else, and the public
 * fetch handler exposes none of it.
 */

const TOKEN = 'workers-test-internal-token-abcdef'

function api(over: Partial<InternalEnv> = {}): InternalApi {
  const e = { ...env, INTERNAL_SERVICE_TOKEN: TOKEN, INTERNAL_ALLOWED_DOMAINS: 'swayq.com', ...over } as InternalEnv
  // WorkerEntrypoint's constructor is (ctx, env), which is what the runtime
  // calls when a service binding invokes the entrypoint.
  return new InternalApi(createExecutionContext() as never, e as never)
}

beforeAll(async () => {
  await env.DB.prepare('INSERT OR IGNORE INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
    .bind('u_internal_jh', 'jh@swayq.com', 'JH', 'Europe/Copenhagen', 'jh-internal', Date.now())
    .run()
})

describe('InternalApi entrypoint', () => {
  it('refuses everything when INTERNAL_SERVICE_TOKEN is unset', async () => {
    const res = await api({ INTERNAL_SERVICE_TOKEN: undefined }).myBookingLinks({ token: TOKEN, actingUserEmail: 'jh@swayq.com' })
    expect(res).toMatchObject({ ok: false, code: 'SERVICE_NOT_CONFIGURED' })
  })

  it('refuses a wrong token', async () => {
    const res = await api().myBookingLinks({ token: 'wrong', actingUserEmail: 'jh@swayq.com' })
    expect(res).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('resolves the actor against real D1: unknown refused, known served', async () => {
    const unknown = await api().myBookingLinks({ token: TOKEN, actingUserEmail: 'nobody@swayq.com' })
    expect(unknown).toMatchObject({ ok: false, code: 'UNKNOWN_ACTOR' })
    const known = await api().myBookingLinks({ token: TOKEN, actingUserEmail: ' JH@swayq.com ' })
    expect(known).toEqual({ ok: true, links: [] })
  })

  it('refuses an external attendee before any calendar is touched', async () => {
    const res = await api().findTime({
      token: TOKEN,
      actingUserEmail: 'jh@swayq.com',
      attendeeEmails: ['client@brand.dk'],
      durationMinutes: 30,
      windowStart: '2026-10-19T00:00:00Z',
      windowEnd: '2026-10-24T00:00:00Z',
      timezone: 'Europe/Copenhagen',
    })
    expect(res).toMatchObject({ ok: false, code: 'EXTERNAL_ATTENDEE', externalEmails: ['client@brand.dk'] })
  })
})

describe('the RPC surface', () => {
  it('has exactly the six methods: no helper is a class member (TS private is still RPC-callable)', () => {
    expect(Object.getOwnPropertyNames(InternalApi.prototype).sort()).toEqual([
      'cancelMeeting',
      'constructor',
      'createMeeting',
      'findTime',
      'listMyMeetings',
      'myBookingLinks',
      'rescheduleMeeting',
    ])
  })

  it("the entrypoint's own gate runs before the engine is built", async () => {
    // A deployment whose engine cannot be built (template BASE_URL): only the
    // entrypoint gate can answer UNAUTHORIZED / SERVICE_NOT_CONFIGURED here;
    // without it every call would be INTERNAL_ERROR.
    const broken = { BASE_URL: 'https://punctual.YOUR-SUBDOMAIN.workers.dev' }
    expect(await api(broken).myBookingLinks({ token: 'wrong', actingUserEmail: 'jh@swayq.com' })).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    })
    expect(
      await api({ ...broken, INTERNAL_ALLOWED_DOMAINS: undefined }).myBookingLinks({ token: TOKEN, actingUserEmail: 'jh@swayq.com' }),
    ).toMatchObject({ ok: false, code: 'SERVICE_NOT_CONFIGURED' })
    // With the right token and config, the broken engine surfaces as INTERNAL_ERROR, nothing more.
    expect(await api(broken).myBookingLinks({ token: TOKEN, actingUserEmail: 'jh@swayq.com' })).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'internal error',
    })
  })

  it('refuses every method when INTERNAL_ALLOWED_DOMAINS is unset or malformed', async () => {
    for (const domains of [undefined, '', '@swayq.com']) {
      const res = await api({ INTERNAL_ALLOWED_DOMAINS: domains }).myBookingLinks({ token: TOKEN, actingUserEmail: 'jh@swayq.com' })
      expect(res).toMatchObject({ ok: false, code: 'SERVICE_NOT_CONFIGURED' })
    }
  })
})

describe('the public fetch handler exposes no internal method', () => {
  const paths = [
    '/findTime',
    '/createMeeting',
    '/InternalApi/findTime',
    '/internal/createMeeting',
    '/api/internal/findTime',
    '/rpc/InternalApi.createMeeting',
  ]
  for (const path of paths) {
    for (const method of ['GET', 'POST']) {
      it(`${method} ${path} is a 404`, async () => {
        const res = await worker.fetch(
          new Request(`https://punctual.test${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(method === 'POST'
              ? { body: JSON.stringify({ token: TOKEN, actingUserEmail: 'jh@swayq.com', attendeeEmails: [] }) }
              : {}),
          }),
          { ...env, INTERNAL_SERVICE_TOKEN: TOKEN } as never,
          createExecutionContext(),
        )
        expect(res.status).toBe(404)
      })
    }
  }
})
