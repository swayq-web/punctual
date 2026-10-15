/**
 * Classify a calendar provider error as retryable or permanent.
 *
 * Retryable errors are rethrown so the queue redelivers the message (with
 * backoff); permanent ones mark the booking `failed` and tell the host at
 * once, instead of burning five retries on a revoked grant.
 *
 * Errors are recognised by their brands and `status`, not `instanceof`, for
 * the same cross-bundle reason oauth.ts brands them.
 */

import type { CalendarSyncErrorCategory } from '../core/domain/types.js'
import { isRetryableCategory } from '../core/domain/calendar-sync.js'
import { needsReconnect, needsSetup } from './oauth.js'

/** Google answers quota exhaustion with a 403 naming one of these reasons, not a 429. */
const GOOGLE_RATE_LIMIT_403 = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RATE_LIMIT_EXCEEDED/i

export function classifyCalendarError(err: unknown): CalendarSyncErrorCategory {
  if (needsReconnect(err)) return 'needs_reconnect'
  if (needsSetup(err)) return 'setup_required'

  const status = statusOf(err)
  if (status !== undefined) {
    if (status === 429) return 'rate_limited'
    if (status === 403) return GOOGLE_RATE_LIMIT_403.test(bodyOf(err)) ? 'rate_limited' : 'permission_denied'
    if (status === 404 || status === 410) return 'not_found'
    if (status === 408) return 'network'
    if (status >= 500) return 'provider_unavailable'
    if (status >= 400) return 'rejected'
    // A 2xx the adapter could not use (no id, non-JSON): the provider
    // misbehaved, which a retry may well fix.
    return 'provider_unavailable'
  }

  // A provider error with no status is one the adapter raised before any
  // request: no write calendar configured, provider credentials removed,
  // malformed stored tokens. None of those fixes itself.
  if (isProviderError(err)) return 'rejected'

  // Anything else is the transport: fetch's TypeError, an AbortError from a
  // timeout, a Worker subrequest limit. The request may or may not have
  // reached the provider, which is exactly why creates carry a stable event
  // id (adapters/calendar-ids.ts) and a retry is safe.
  return 'network'
}

export function isRetryable(err: unknown): boolean {
  return isRetryableCategory(classifyCalendarError(err))
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const s = (err as { status?: unknown }).status
  return typeof s === 'number' && Number.isFinite(s) ? s : undefined
}

function bodyOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return ''
  const b = (err as { body?: unknown }).body
  return typeof b === 'string' ? b : ''
}

function isProviderError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'CalendarApiError'
}

/**
 * Thrown out of the calendar sync so `handleQueueBatch` retries the message
 * with backoff. Carries only the category: the provider's own error is
 * logged as a category too, never as its body.
 */
export class CalendarSyncRetryableError extends Error {
  readonly category: CalendarSyncErrorCategory
  readonly calendarSyncRetry = true as const

  constructor(bookingId: string, category: CalendarSyncErrorCategory) {
    super(`calendar sync for booking ${bookingId} will be retried: ${category}`)
    this.name = 'CalendarSyncRetryableError'
    this.category = category
  }
}

export function isCalendarSyncRetry(err: unknown): err is CalendarSyncRetryableError {
  return typeof err === 'object' && err !== null && (err as { calendarSyncRetry?: unknown }).calendarSyncRetry === true
}

/**
 * One structured log line for the sync pipeline. The fields are fixed on
 * purpose: booking id, stage, category, attempt and connection id, and
 * nothing that could carry a guest's name, email, answers or a token.
 */
export function logSync(
  level: 'info' | 'warn' | 'error',
  fields: {
    event: string
    bookingId: string
    stage: 'create' | 'update' | 'delete' | 'dead_letter' | 'reconcile' | 'drift_check'
    category?: CalendarSyncErrorCategory | null
    attempt?: number
    connectionId?: string
    provider?: string
  },
): void {
  const line = JSON.stringify({ source: 'punctual.calendar_sync', ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
