/**
 * Configuration gates for the internal entrypoint: the shared service token
 * and the REQUIRED email-domain allowlist. Both fail closed.
 *
 * Token comparison is constant time: both sides are hashed to fixed-length
 * SHA-256 digests first, so neither the length nor the first differing byte
 * of the expected secret leaks through timing, and every digest byte is
 * compared (`bytesEqual`). Works in workerd and plain Node (no reliance on
 * the non-standard `crypto.subtle.timingSafeEqual`).
 */

export type TokenVerdict = 'ok' | 'not_configured' | 'unauthorized'

export async function verifyServiceToken(expected: string | undefined, presented: unknown): Promise<TokenVerdict> {
  // An unset or blank secret refuses EVERYTHING. Never "no secret means open".
  if (typeof expected !== 'string' || expected.trim() === '') return 'not_configured'
  if (typeof presented !== 'string' || presented === '') return 'unauthorized'
  const [a, b] = await Promise.all([digest(expected), digest(presented)])
  return bytesEqual(a, b) ? 'ok' : 'unauthorized'
}

/** Constant-time equality over two byte arrays: every byte of the longer one is visited. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** A bare domain: lowercase labels joined by dots, at least one dot. No `@`, no spaces, no wildcards. */
const BARE_DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * INTERNAL_ALLOWED_DOMAINS, parsed. REQUIRED: Punctual signups are open by
 * default and changeable at runtime by an admin, so "is a Punctual user"
 * alone would let anyone who signs up be invited. Returns null (= the API is
 * not configured, every call refused) when unset, empty, or when ANY entry
 * is not a bare domain: a typo like "@swayq.com" or "swayq .com" must not
 * silently shrink or widen the gate.
 */
export function parseAllowedDomains(raw: string | undefined): string[] | null {
  if (typeof raw !== 'string') return null
  const entries = raw.split(',').map((e) => e.trim().toLowerCase())
  if (entries.length === 0 || entries.some((e) => !BARE_DOMAIN.test(e))) return null
  return [...new Set(entries)]
}
