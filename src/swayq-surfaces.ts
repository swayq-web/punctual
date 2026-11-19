/**
 * SwayQ surface switches: the ONE place that decides which upstream Punctual
 * surfaces are reachable in the SwayQ booking deployment.
 *
 * Nothing upstream is deleted. A surface that is `false` here is unmounted
 * (its route answers 404 from `src/http/router.ts`) and its entry points in
 * the host dashboard are not rendered. Flip a flag to `true` to get the
 * upstream behaviour back; no other file needs to change.
 *
 * Audit this object and `blockedSurface` below: together they are the whole
 * list. Pages read the flags through `SWAYQ_SURFACES`, the router through
 * `blockedSurface` / `blockedByForm`.
 */

export interface SurfaceFlags {
  /** Avatar and logo upload, and the `/avatars/:key` R2 route. Pages fall back to initials. */
  avatars: boolean
  /** The dashboard Insights page. */
  insights: boolean
  /** Microsoft sign-in and calendar connect (`/auth/microsoft/*`). */
  microsoft: boolean
  /** The Telegram notification channel. Slack stays. */
  telegram: boolean
  /** Public API-key issuance UI (`/dashboard/api-keys*`). The REST API itself stays mounted. */
  apiKeys: boolean
  /** The native `/mcp` route. */
  mcp: boolean
  /** Team-owned event types: round robin and collective creation UI. */
  teamScheduling: boolean
}

export const SWAYQ_SURFACES: SurfaceFlags = {
  avatars: false,
  insights: false,
  microsoft: false,
  telegram: false,
  apiKeys: false,
  mcp: false,
  teamScheduling: false,
}

export type SurfaceName = keyof SurfaceFlags

/**
 * The upstream product pages: the marketing landing at `/`, `/docs*`,
 * `/calendly-alternative`, and every line or link that names the upstream
 * project (footers, dashboard docs links, the "open source" legal sections,
 * the static link-preview card).
 *
 * Unlike the flags above this one is per DEPLOYMENT: it is the `UPSTREAM_PAGES`
 * var (`EngineConfig.upstreamPages`). `wrangler.toml`, the upstream self-host
 * template, turns it on; SwayQ's `wrangler.staging.toml` and
 * `wrangler.production.toml` turn it off, and an unset var is off too, so a
 * config that forgets it never shows upstream marketing.
 *
 * The router copies the config value here on every request, so page renderers
 * read one switch instead of each taking another parameter. A deployment has
 * one value for its whole life, so this is a constant in practice.
 */
let upstreamPagesOn = false

/** "1" or "true" (any case) is on; anything else, or unset, is off. */
export function parseSwitch(value: string | undefined | null): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

export function setUpstreamPages(on: boolean): void {
  upstreamPagesOn = on
}

export function upstreamPages(): boolean {
  return upstreamPagesOn
}

/** Paths that exist only as upstream product pages. `/` is not here: it redirects instead (router). */
export function isUpstreamPagePath(pathname: string): boolean {
  return under(pathname, '/docs') || pathname === '/calendly-alternative'
}

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`)
}

/**
 * The switched-off surface a request path belongs to, or null. Path-only, so
 * it is cheap enough to run on every request. Form-body decisions (a Telegram
 * channel is a POST to a shared endpoint) are `blockedByForm`.
 */
export function blockedSurface(pathname: string, flags: SurfaceFlags = SWAYQ_SURFACES): SurfaceName | null {
  if (!flags.avatars) {
    if (under(pathname, '/avatars')) return 'avatars'
    if (under(pathname, '/dashboard/settings/avatar')) return 'avatars'
    if (/^\/dashboard\/event-types\/[^/]+\/logo(\/|-shape$|$)/.test(pathname)) return 'avatars'
    if (under(pathname, '/dashboard/admin/logo') || pathname === '/dashboard/admin/logo-shape') return 'avatars'
  }
  if (!flags.insights && under(pathname, '/dashboard/insights')) return 'insights'
  if (!flags.microsoft && under(pathname, '/auth/microsoft')) return 'microsoft'
  if (!flags.apiKeys && under(pathname, '/dashboard/api-keys')) return 'apiKeys'
  if (!flags.teamScheduling && under(pathname, '/dashboard/teams')) return 'teamScheduling'
  // `mcp` is not path-gated: the router simply does not mount the sub-app
  // (and so `/mcp/...` falls through to the ordinary 404 / booking routes).
  return null
}

/** POST endpoints that serve several channel kinds from one URL. */
export function isChannelCreatePath(pathname: string): boolean {
  return pathname === '/dashboard/notifications' || /^\/dashboard\/teams\/[^/]+\/notifications$/.test(pathname)
}

const DASHBOARD_EVENT_TYPE_WRITE = /^\/dashboard\/event-types(\/[^/]+)?$/
const API_EVENT_TYPE_WRITE = /^\/api\/v1\/event-types(\/[^/]+)?$/

/** Paths whose switch depends on what the request body says (the router reads a clone of it). */
export function needsBodyCheck(pathname: string): boolean {
  return (
    isChannelCreatePath(pathname) || DASHBOARD_EVENT_TYPE_WRITE.test(pathname) || API_EVENT_TYPE_WRITE.test(pathname)
  )
}

/**
 * True when a form or JSON body asks for a switched-off thing at a shared
 * endpoint: a Telegram channel, or a team-owned event type (round robin and
 * collective) from the dashboard form (`owner`) or the API (`ownerTeamId`).
 */
export function blockedByForm(
  pathname: string,
  form: { get(name: string): unknown },
  flags: SurfaceFlags = SWAYQ_SURFACES,
): SurfaceName | null {
  if (!flags.telegram && isChannelCreatePath(pathname) && String(form.get('kind') ?? '') === 'telegram') {
    return 'telegram'
  }
  if (!flags.teamScheduling) {
    if (DASHBOARD_EVENT_TYPE_WRITE.test(pathname) && String(form.get('owner') ?? '').trim() !== '') return 'teamScheduling'
    if (API_EVENT_TYPE_WRITE.test(pathname)) {
      const owner = form.get('ownerTeamId')
      if (typeof owner === 'string' ? owner.trim() !== '' : owner != null && owner !== false) return 'teamScheduling'
    }
  }
  return null
}

/** The media type of a Content-Type header: lower-cased, parameters dropped. */
export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase()
}

/** True only for `application/json` and `+json` structured types, decided on the media type alone. */
export function isJsonMediaType(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json')
}

/**
 * Parse a request body for `blockedByForm`. The body is read the way the
 * handler behind the path will read it, never by a substring of the header (a
 * parameter such as `; x=json` must not steer the choice):
 *  - the REST API ignores Content-Type and parses the text as JSON, so the
 *    API paths are always JSON here (an empty body is `{}`, as it is there);
 *  - dashboard forms are JSON only when the parsed media type says so, else
 *    urlencoded or multipart.
 * Returns null when the body cannot be parsed; the router treats that as
 * blocked, because a gate that lets an unreadable body through is bypassed
 * by sending one.
 */
export async function readSurfaceBody(raw: Request, pathname: string): Promise<{ get(name: string): unknown } | null> {
  const asJson = API_EVENT_TYPE_WRITE.test(pathname) || isJsonMediaType(mediaType(raw.headers.get('content-type')))
  try {
    if (asJson) {
      const text = await raw.text()
      const j = (text.trim() === '' ? {} : JSON.parse(text)) as unknown
      return { get: (k: string) => (j as Record<string, unknown> | null)?.[k] }
    }
    return await raw.formData()
  } catch {
    return null
  }
}
