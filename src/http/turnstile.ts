/**
 * Cloudflare Turnstile on the booking confirm form.
 *
 * Configuration (Worker vars/secrets, read from the request's `env`):
 *   TURNSTILE_SITE_KEY   var     public key rendered into the widget
 *   TURNSTILE_SECRET     secret  server key for siteverify
 *   TURNSTILE_REQUIRED   var     "1" / "true": a deployment that MUST challenge
 *
 * The decision table (`decideTurnstile`) is the whole policy:
 *
 *   secret set                    -> verify the token with siteverify
 *   secret unset, required        -> REFUSE (fail closed: a production
 *                                    deployment that lost its secret must not
 *                                    silently stop challenging)
 *   secret unset, not required    -> skip, with a console warning (local dev)
 *
 * "Not required" is the explicit opt-out, not the absence of configuration
 * being forgiven: a deployment turns enforcement on by setting
 * TURNSTILE_REQUIRED, and from then on a missing secret is an outage the
 * operator sees, never a hole a bot walks through.
 */

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
export const TURNSTILE_FORM_FIELD = 'cf-turnstile-response'

export interface TurnstileConfig {
  siteKey: string | undefined
  secret: string | undefined
  required: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

export function turnstileConfig(env: Record<string, unknown> | undefined): TurnstileConfig {
  const required = str(env?.['TURNSTILE_REQUIRED'])?.toLowerCase()
  return {
    siteKey: str(env?.['TURNSTILE_SITE_KEY']),
    secret: str(env?.['TURNSTILE_SECRET']),
    required: required === '1' || required === 'true',
  }
}

/** Render the widget when a site key exists, or when it is required (so the missing key shows up as a refusal, not silence). */
export function turnstileWidgetKey(cfg: TurnstileConfig): string | undefined {
  return cfg.siteKey
}

export type TurnstileDecision = 'verify' | 'skip' | 'refuse'

export function decideTurnstile(cfg: TurnstileConfig): TurnstileDecision {
  if (cfg.secret) return 'verify'
  return cfg.required ? 'refuse' : 'skip'
}

export type TurnstileResult = { ok: true; skipped?: true } | { ok: false; reason: 'missing_token' | 'rejected' | 'unconfigured' | 'unreachable' }

export async function verifyTurnstile(
  cfg: TurnstileConfig,
  token: string | null | undefined,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const decision = decideTurnstile(cfg)
  if (decision === 'skip') {
    console.warn('[punctual] Turnstile skipped: TURNSTILE_SECRET is unset and TURNSTILE_REQUIRED is not. Never run production like this.')
    return { ok: true, skipped: true }
  }
  if (decision === 'refuse') {
    console.error('[punctual] Turnstile is REQUIRED but TURNSTILE_SECRET is not set: refusing bookings until it is.')
    return { ok: false, reason: 'unconfigured' }
  }
  const response = (token ?? '').trim()
  // Turnstile tokens are at most 2048 chars; refuse junk before spending a subrequest on it.
  if (response === '' || response.length > 2048) return { ok: false, reason: 'missing_token' }

  const body = new URLSearchParams({ secret: cfg.secret!, response })
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp)
  try {
    const res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, { method: 'POST', body })
    if (!res.ok) return { ok: false, reason: 'unreachable' }
    const json = (await res.json()) as { success?: boolean }
    return json.success === true ? { ok: true } : { ok: false, reason: 'rejected' }
  } catch (err) {
    // Fail closed: if the challenge cannot be checked, the booking is not taken.
    console.error('[punctual] Turnstile siteverify failed', err)
    return { ok: false, reason: 'unreachable' }
  }
}
