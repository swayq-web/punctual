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
  // `mcp` is not path-gated: the router simply does not mount the sub-app
  // (and so `/mcp/...` falls through to the ordinary 404 / booking routes).
  return null
}

/** POST endpoints that serve several channel kinds from one URL. */
export function isChannelCreatePath(pathname: string): boolean {
  return pathname === '/dashboard/notifications' || /^\/dashboard\/teams\/[^/]+\/notifications$/.test(pathname)
}

/** True when a channel-create form asks for a switched-off kind. */
export function blockedByForm(
  pathname: string,
  form: { get(name: string): unknown },
  flags: SurfaceFlags = SWAYQ_SURFACES,
): SurfaceName | null {
  if (!flags.telegram && isChannelCreatePath(pathname) && String(form.get('kind') ?? '') === 'telegram') {
    return 'telegram'
  }
  return null
}
