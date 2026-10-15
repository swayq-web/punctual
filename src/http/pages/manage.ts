/**
 * The guest manage pages: view a booking, reschedule it, cancel it.
 *
 * Moved out of pages/dashboard.ts (which re-exports these names) because they
 * are guest-facing, not host-facing: they speak the guest's language (en/da),
 * wear the SwayQ skin, and are the pages whose URL carries a credential.
 *
 * A manage URL is a bearer token, so every page here:
 *   - says `noindex` (meta here, `X-Robots-Tag` from the route),
 *   - sends no referrer (`<meta name="referrer">` here, `Referrer-Policy` from
 *     the route),
 *   - names no third-party origin: the footer wordmark is not a link, fonts
 *     are same-origin, and there is no script at all.
 * The route adds `Cache-Control: no-store` with the other two headers
 * (`manageHeaders`).
 */

import type { Booking, EventType, Slot, User } from '../../core/domain/types.js'
import { formatDateTime, formatWhenLong, t, type Locale, type MessageKey } from '../../core/i18n/index.js'
import { localDateString, offsetLabel } from '../../core/time/zone.js'
import { slotStateClassName } from '../../core/slot-state.js'
import { errorPage, escapeHtml, shellFoot, shellHead, tzName } from './booking.js'

export interface BookingDetailPageData {
  brandName: string
  booking: Booking
  /** Null when the event type has since been deleted; the booking still stands. */
  eventType: EventType | null
  host: User
  /**
   * The signed manage token from the query string. It is the credential
   * (ADR-0005 §4) and travels back on every form, which is also why these
   * forms carry no CSRF token: there is no session and no ambient authority to
   * forge, exactly as on the public booking page (ADR-0005 §5).
   */
  token: string
  /**
   * The token's real purpose. `manage` authorises BOTH actions and is the only
   * purpose the coordinator mints, so narrowing this type is what previously
   * hid the cancel form from every guest.
   */
  purpose: 'manage' | 'cancel' | 'reschedule'
  /** Times offered for a reschedule, when the guest picked a day. */
  slots?: Slot[]
  selectedDate?: string
  /** Set once the guest chose a time, so the page can ask for confirmation. */
  newStart?: number
  error?: string
  locale?: Locale
}

/** The headers every credential-bearing guest page carries. */
export function manageHeaders(): Record<string, string> {
  return {
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    vary: 'Accept-Language, Cookie',
  }
}

function chrome(locale: Locale, brandName: string, title: string, langHref?: (l: Locale) => string) {
  return shellHead({
    title: `${title} · ${brandName}`,
    brandName,
    guest: true,
    locale,
    sensitive: true,
    ...(langHref ? { langHref } : {}),
  })
}

const foot = (locale: Locale, brandName: string): string => shellFoot(true, false, null, { locale, brandName })

export function bookingDetailPage(d: BookingDetailPageData): string {
  const locale = d.locale ?? 'en'
  const tz = d.booking.guestTimezone
  const when = formatWhenLong(locale, d.booking.startUtc, tz)
  const title = d.eventType?.title ?? t(locale, 'manage.fallbackTitle')
  const cancelled = d.booking.status !== 'confirmed'
  const tokenField = `<input type="hidden" name="token" value="${escapeHtml(d.token)}">`
  const base = `/booking/${encodeURIComponent(d.booking.id)}?token=${encodeURIComponent(d.token)}`

  return (
    chrome(locale, d.brandName, title, (l) => `${base}&lang=${l}`) +
    `<section class="pu-card" aria-label="${escapeHtml(t(locale, 'manage.region'))}">
  <p><span class="pu-badge"${cancelled ? ' style="background:var(--pu-paper-dim);color:var(--pu-ink-500)"' : ''}>${escapeHtml(statusLabel(d.booking, locale))}</span></p>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(t(locale, 'manage.with', { host: d.host.name || d.host.slug }))}</p>
  <p class="pu-time"><strong>${escapeHtml(when)}</strong><br>
    <span class="pu-muted">${escapeHtml(tzName(tz))} (${escapeHtml(offsetLabel(d.booking.startUtc, tz))}) · ${escapeHtml(
      t(locale, 'duration.min', { n: Math.round((d.booking.endUtc - d.booking.startUtc) / 60000) }),
    )}</span></p>
  ${d.eventType ? `<p class="pu-muted">${escapeHtml(locationLabel(d.eventType, locale))}</p>` : ''}
  ${d.error ? `<p class="pu-err" role="alert">${escapeHtml(d.error)}</p>` : ''}
</section>` +
    (cancelled
      ? `<section class="pu-card" style="margin-top:1.5rem">
  <p class="pu-muted">${escapeHtml(t(locale, 'manage.inactive'))}</p>
</section>`
      : rescheduleSection(d, tokenField, locale) + cancelSection(d, tokenField, locale)) +
    foot(locale, d.brandName)
  )
}

function statusLabel(b: Booking, locale: Locale): string {
  switch (b.status) {
    case 'cancelled':
      return t(locale, 'manage.status.cancelled')
    case 'rescheduled':
      return t(locale, 'manage.status.moved')
    default:
      return t(locale, 'manage.status.confirmed')
  }
}

function locationLabel(et: EventType, locale: Locale): string {
  switch (et.locationType) {
    case 'google_meet':
      return t(locale, 'loc.meet')
    case 'phone':
      return t(locale, 'loc.phone')
    case 'in_person':
      return et.locationValue ?? t(locale, 'loc.inPerson')
    case 'custom_link':
      return t(locale, 'loc.online')
    default:
      return ''
  }
}

function rescheduleSection(d: BookingDetailPageData, tokenField: string, locale: Locale): string {
  // 'manage' authorises this too.
  if (d.purpose !== 'reschedule' && d.purpose !== 'manage') {
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="${escapeHtml(t(locale, 'manage.reschedule.pickTitle'))}">
  <h2>${escapeHtml(t(locale, 'manage.reschedule.onlyCancelTitle'))}</h2>
  <p class="pu-muted">${escapeHtml(t(locale, 'manage.reschedule.onlyCancelBody'))}</p>
</section>`
  }

  const path = d.eventType
    ? `/booking/${encodeURIComponent(d.booking.id)}?token=${encodeURIComponent(d.token)}`
    : null
  if (!path) {
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="${escapeHtml(t(locale, 'manage.reschedule.goneTitle'))}">
  <h2>${escapeHtml(t(locale, 'manage.reschedule.goneTitle'))}</h2>
  <p class="pu-muted">${escapeHtml(t(locale, 'manage.reschedule.goneBody'))}</p>
</section>`
  }

  const tz = d.booking.guestTimezone
  // The language rides along on every internal link of the picker: the guest chose it, or it is stored, and neither should reset on a click.
  const langParam = `&lang=${locale}`

  if (d.newStart !== undefined) {
    const when = formatWhenLong(locale, d.newStart, tz)
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="${escapeHtml(t(locale, 'manage.reschedule.confirmTitle'))}">
  <h2>${escapeHtml(t(locale, 'manage.reschedule.confirmTitle'))}</h2>
  <p class="pu-time"><strong>${escapeHtml(when)}</strong><br>
    <span class="pu-muted">${escapeHtml(`${tzName(tz)} (${offsetLabel(d.newStart, tz)})`)}</span></p>
  <form method="post" action="/booking/${encodeURIComponent(d.booking.id)}/reschedule">
    ${tokenField}
    <input type="hidden" name="lang" value="${locale}">
    <input type="hidden" name="start" value="${d.newStart}">
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="pu-btn" type="submit">${escapeHtml(t(locale, 'manage.reschedule.confirmCta'))}</button>
      <a class="pu-btn pu-btn-ghost" href="${escapeHtml(path + langParam)}">${escapeHtml(t(locale, 'manage.back'))}</a>
    </div>
  </form>
</section>`
  }

  const date = d.selectedDate ?? localDateString(d.booking.startUtc, tz)
  const slots = d.slots ?? []
  const list =
    slots.length === 0
      ? `<p class="pu-muted">${escapeHtml(t(locale, 'manage.reschedule.none'))}</p>`
      : `<div class="pu-slots">
    ${slots
      .map((s) => {
        const label = formatDateTime(locale, s.start, tz, { hour: 'numeric', minute: '2-digit' })
        const href = `${path}&date=${encodeURIComponent(date)}&start=${s.start}${langParam}`
        return `<a class="${slotStateClassName('available')}" href="${escapeHtml(href)}">
      <time datetime="${new Date(s.start).toISOString()}">${escapeHtml(label)}</time></a>`
      })
      .join('\n    ')}
  </div>`

  return `<section class="pu-card" style="margin-top:1.5rem" aria-label="${escapeHtml(t(locale, 'manage.reschedule.pickTitle'))}">
  <h2>${escapeHtml(t(locale, 'manage.reschedule.pickTitle'))}</h2>
  <form method="get" action="/booking/${encodeURIComponent(d.booking.id)}">
    <input type="hidden" name="token" value="${escapeHtml(d.token)}">
    <input type="hidden" name="lang" value="${locale}">
    <label for="date">${escapeHtml(t(locale, 'manage.reschedule.day'))}</label>
    <input id="date" name="date" type="date" lang="${locale}" value="${escapeHtml(date)}">
    <div style="margin-top:.75rem"><button class="pu-btn pu-btn-ghost" type="submit">${escapeHtml(t(locale, 'manage.reschedule.showTimes'))}</button></div>
  </form>
  <p class="pu-muted pu-tz-note" style="margin-top:1rem">
    ${escapeHtml(t(locale, 'manage.reschedule.timesIn', { tz: tzName(tz), offset: offsetLabel(slots[0]?.start ?? d.booking.startUtc, tz) }))}</p>
  ${list}
</section>`
}

function cancelSection(d: BookingDetailPageData, tokenField: string, locale: Locale): string {
  // A 'manage' token authorises both actions, and it is the ONLY purpose the
  // coordinator mints.
  if (d.purpose !== 'cancel' && d.purpose !== 'manage') {
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="${escapeHtml(t(locale, 'manage.cancel.title'))}">
  <h2>${escapeHtml(t(locale, 'manage.cancel.onlyRescheduleTitle'))}</h2>
  <p class="pu-muted">${escapeHtml(t(locale, 'manage.cancel.onlyRescheduleBody'))}</p>
</section>`
  }
  return `<form class="pu-card" method="post" style="margin-top:1.5rem"
      action="/booking/${encodeURIComponent(d.booking.id)}/cancel">
  ${tokenField}
  <input type="hidden" name="lang" value="${locale}">
  <h2>${escapeHtml(t(locale, 'manage.cancel.title'))}</h2>
  <p class="pu-muted">${escapeHtml(t(locale, 'manage.cancel.body'))}</p>
  <button class="pu-btn pu-btn-danger" type="submit">${escapeHtml(t(locale, 'manage.cancel.cta'))}</button>
</form>`
}

/** Shared "this link is not valid" page. Says nothing about why. */
export function manageLinkErrorPage(brandName: string, message: string, locale: Locale = 'en'): string {
  return (
    chrome(locale, brandName, t(locale, 'manage.linkError.pageTitle')) +
    `<section class="pu-card">
  <h1>${escapeHtml(t(locale, 'manage.linkError.title'))}</h1>
  <p class="pu-muted">${escapeHtml(message)}</p>
  <p class="pu-muted">${escapeHtml(t(locale, 'manage.linkError.hint'))}</p>
</section>` +
    foot(locale, brandName)
  )
}

/** A plain result page on a manage route (cancelled, refused). Same chrome, same headers. */
export function manageResultPage(
  brandName: string,
  locale: Locale,
  pageTitleKey: MessageKey,
  title: string,
  message: string,
): string {
  return (
    chrome(locale, brandName, t(locale, pageTitleKey)) + errorPage(title, message) + foot(locale, brandName)
  )
}
