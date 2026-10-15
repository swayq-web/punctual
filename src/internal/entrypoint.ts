/**
 * `InternalApi`: the named WorkerEntrypoint SwayQ's app Worker binds to.
 *
 * Why a named entrypoint: a non-default `WorkerEntrypoint` export is
 * reachable ONLY through a service binding from another Worker in the same
 * Cloudflare account (`[[services]] ... entrypoint = "InternalApi"`). The
 * public `fetch` handler (the default export) never mounts these methods, so
 * there is no URL on the internet that reaches them.
 *
 * Why ALSO a shared token: defense in depth. The binding is the perimeter;
 * the token makes a misconfigured binding (another Worker in the account
 * bound by mistake, a future refactor that routes HTTP to this class) fail
 * closed instead of open. An unset INTERNAL_SERVICE_TOKEN refuses every call.
 *
 * RPC methods take one plain object and return a plain `InternalResult`
 * union (src/internal/contract.ts); they never throw across the boundary.
 */

import { WorkerEntrypoint } from 'cloudflare:workers'
import { buildPorts, type Env } from '../index.js'
import type { CalendarProviderDeps } from '../adapters/oauth.js'
import type { EnginePorts } from '../ports.js'
import type {
  CancelMeetingInput,
  CancelMeetingOutput,
  CreateMeetingInput,
  CreateMeetingOutput,
  FindTimeInput,
  FindTimeOutput,
  InternalResult,
  ListMyMeetingsInput,
  ListMyMeetingsOutput,
  MeetingOutput,
  MyBookingLinksInput,
  MyBookingLinksOutput,
  RescheduleMeetingInput,
} from './contract.js'
import { createInternalService, type InternalService } from './service.js'
import { verifyServiceToken } from './token.js'

export interface InternalEnv extends Env {
  /** Shared secret the calling Worker passes as `token`. Unset = every call refused. */
  INTERNAL_SERVICE_TOKEN?: string
  /** Optional comma list of email domains actor and attendees must belong to, e.g. "swayq.com". */
  INTERNAL_ALLOWED_DOMAINS?: string
}

/**
 * Provider deps for the Google event calls, built from the SAME ports the
 * engine uses, with the same token-refresh persistence as `buildPorts`
 * (rotated tokens are stored immediately, under the row-bound AAD).
 */
export function providerDepsFromPorts(ports: EnginePorts): CalendarProviderDeps {
  return {
    oauth: ports.oauth,
    crypto: ports.crypto,
    clock: ports.clock,
    onTokensRefreshed: async (connectionId, tokens) => {
      const repos = ports.repositories({ consistency: 'bookmark' })
      const conn = await repos.connections.byId(connectionId)
      if (!conn) return
      const { ciphertext, keyVersion } = await ports.crypto.encrypt(
        JSON.stringify(tokens),
        `${conn.userId}|${conn.provider}|${conn.id}`,
      )
      await repos.connections.updateTokens(connectionId, ciphertext, keyVersion)
    },
  }
}

export function serviceFromEnv(env: InternalEnv): InternalService {
  const ports = buildPorts(env)
  return createInternalService({
    ports,
    providerDeps: providerDepsFromPorts(ports),
    serviceToken: env.INTERNAL_SERVICE_TOKEN,
    allowedDomains: (env.INTERNAL_ALLOWED_DOMAINS ?? '').split(','),
  })
}

export class InternalApi extends WorkerEntrypoint<InternalEnv> {
  private service(): InternalService {
    return serviceFromEnv(this.env)
  }

  /**
   * The token is checked BEFORE the engine is built, so an unauthenticated
   * caller costs nothing and cannot probe configuration errors. buildPorts
   * can throw on a misconfigured deployment; that must still be a typed
   * result. The service re-checks the token itself (it is also callable
   * directly in tests and by future embedders).
   */
  private async call<T>(input: unknown, fn: (s: InternalService) => Promise<InternalResult<T>>): Promise<InternalResult<T>> {
    const presented = typeof input === 'object' && input !== null ? (input as { token?: unknown }).token : undefined
    const verdict = await verifyServiceToken(this.env.INTERNAL_SERVICE_TOKEN, presented)
    if (verdict === 'not_configured') {
      return { ok: false, code: 'SERVICE_NOT_CONFIGURED', message: 'internal API is not configured on this deployment' }
    }
    if (verdict !== 'ok') return { ok: false, code: 'UNAUTHORIZED', message: 'invalid service token' }
    let svc: InternalService
    try {
      svc = this.service()
    } catch {
      console.error('[punctual internal] engine misconfigured')
      return { ok: false, code: 'INTERNAL_ERROR', message: 'internal error' }
    }
    return fn(svc)
  }

  findTime(input: FindTimeInput): Promise<InternalResult<FindTimeOutput>> {
    return this.call(input, (s) => s.findTime(input))
  }

  createMeeting(input: CreateMeetingInput): Promise<InternalResult<CreateMeetingOutput>> {
    return this.call(input, (s) => s.createMeeting(input))
  }

  listMyMeetings(input: ListMyMeetingsInput): Promise<InternalResult<ListMyMeetingsOutput>> {
    return this.call(input, (s) => s.listMyMeetings(input))
  }

  rescheduleMeeting(input: RescheduleMeetingInput): Promise<InternalResult<MeetingOutput>> {
    return this.call(input, (s) => s.rescheduleMeeting(input))
  }

  cancelMeeting(input: CancelMeetingInput): Promise<InternalResult<CancelMeetingOutput>> {
    return this.call(input, (s) => s.cancelMeeting(input))
  }

  myBookingLinks(input: MyBookingLinksInput): Promise<InternalResult<MyBookingLinksOutput>> {
    return this.call(input, (s) => s.myBookingLinks(input))
  }
}
