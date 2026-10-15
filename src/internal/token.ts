/**
 * Shared-secret check for the internal entrypoint.
 *
 * Constant time: both sides are hashed to fixed-length SHA-256 digests first,
 * so neither the length nor the first differing byte of the expected secret
 * leaks through timing. Works in workerd and plain Node (no reliance on the
 * non-standard `crypto.subtle.timingSafeEqual`).
 */

export type TokenVerdict = 'ok' | 'not_configured' | 'unauthorized'

export async function verifyServiceToken(expected: string | undefined, presented: unknown): Promise<TokenVerdict> {
  // An unset or blank secret refuses EVERYTHING. Never "no secret means open".
  if (typeof expected !== 'string' || expected.trim() === '') return 'not_configured'
  if (typeof presented !== 'string' || presented === '') return 'unauthorized'
  const [a, b] = await Promise.all([digest(expected), digest(presented)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0 ? 'ok' : 'unauthorized'
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}
