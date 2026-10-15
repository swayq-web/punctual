/**
 * Guest-facing i18n: English and Danish, a typed dictionary, no framework.
 *
 * Scope is deliberately the guest: booking page, confirm form, confirmation,
 * manage pages and guest emails. The host dashboard stays English.
 *
 * Locale precedence (`resolveLocale`): `?lang=` beats the `pu_lang` cookie,
 * which beats the locale stored on the booking (manage pages only), which
 * beats `Accept-Language`, which beats English. A `?lang=` that is not a
 * supported locale is ignored rather than falling through to a surprise.
 *
 * Pure and runtime-neutral (no Cloudflare imports), so the core test project
 * can exercise all of it in plain Node.
 */

import { da } from './da.js'
import { en, type MessageKey } from './en.js'

export type Locale = 'en' | 'da'
export type { MessageKey }

export const LOCALES: readonly Locale[] = ['en', 'da']
export const DEFAULT_LOCALE: Locale = 'en'
export const LANG_COOKIE = 'pu_lang'

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, da }

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'da'
}

/** The BCP 47 tag handed to `Intl`. */
export function intlTag(locale: Locale): string {
  return locale === 'da' ? 'da-DK' : 'en-GB'
}

/** `{name}` placeholders. Unknown placeholders are left visible rather than blanked, so a typo shows up in review. */
function fill(template: string, vars: Record<string, string | number> | undefined): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : String(v)
  })
}

/** Plain-text translation, for titles, emails' text part and attributes (the caller escapes where needed). */
export function t(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  return fill(DICTIONARIES[locale][key] ?? en[key], vars)
}

/** Text-node escaping only: dictionary text is never placed in an attribute, so quotes may stay (an apostrophe in "You'll" reads as itself). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * HTML translation: the dictionary text is escaped, the variables are NOT, so
 * a caller can pass `<strong>…</strong>` it built itself. Every variable the
 * caller passes must already be HTML-safe.
 */
export function tHtml(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  return fill(escapeHtml(DICTIONARIES[locale][key] ?? en[key]), vars)
}

/** First supported language in an `Accept-Language` header, honouring q-values. */
export function parseAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
      const weight = q ? Number(q.slice(2)) : 1
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((x) => x.tag !== '' && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const { tag } of ranked) {
    const primary = tag.split('-')[0]
    if (primary === 'da') return 'da'
    if (primary === 'en') return 'en'
  }
  return undefined
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export interface LocaleInputs {
  /** The `lang` query parameter, if present. */
  query?: string | null
  cookie?: string | null
  /** The locale stored on the booking (`bookings.guest_locale`): what the guest chose when they booked. */
  stored?: string | null
  acceptLanguage?: string | null
}

export interface ResolvedLocale {
  locale: Locale
  /** True when `?lang=` named a supported locale: the cookie should be (re)written and links should carry it. */
  explicit: boolean
}

export function resolveLocale(input: LocaleInputs): ResolvedLocale {
  if (isLocale(input.query)) return { locale: input.query, explicit: true }
  const fromCookie = cookieValue(input.cookie, LANG_COOKIE)
  if (isLocale(fromCookie)) return { locale: fromCookie, explicit: false }
  if (isLocale(input.stored)) return { locale: input.stored, explicit: false }
  return { locale: parseAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE, explicit: false }
}

/** Convenience over a Fetch `Request` + URL. */
export function localeFromRequest(request: Request, stored?: string | null): ResolvedLocale {
  let query: string | null = null
  try {
    query = new URL(request.url).searchParams.get('lang')
  } catch {
    query = null
  }
  return resolveLocale({
    query,
    cookie: request.headers.get('cookie'),
    stored,
    acceptLanguage: request.headers.get('accept-language'),
  })
}

/** A preference, not a credential: readable by script is fine, Lax keeps it first-party. One year. */
export function langCookieHeader(locale: Locale, secure: boolean): string {
  return `${LANG_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/** Danish weeks start on Monday, American ones on Sunday. 0 = Sunday. */
export function weekStartsOn(locale: Locale): 0 | 1 {
  return locale === 'da' ? 1 : 0
}

export function formatDateTime(
  locale: Locale,
  ts: number,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlTag(locale), { ...opts, timeZone }).format(new Date(ts))
}

/** "Friday, September 4 at 9:00 AM" / "fredag den 4. september kl. 09.00": the long form used on confirm pages. */
export function formatWhenLong(locale: Locale, ts: number, timeZone: string): string {
  return formatDateTime(locale, ts, timeZone, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** A calendar date with no time, from a `YYYY-MM-DD` string (zone-free: the date is already local). */
export function formatLocalDate(locale: Locale, date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(intlTag(locale), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function formatMonthYear(locale: Locale, firstOfMonth: Date): string {
  return new Intl.DateTimeFormat(intlTag(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    firstOfMonth,
  )
}

/** Short weekday names for the calendar header, in the locale's week order. Index 0 is the first column. */
export function weekdayNames(locale: Locale, width: 'short' | 'long'): string[] {
  const fmt = new Intl.DateTimeFormat(intlTag(locale), { weekday: width, timeZone: 'UTC' })
  const start = weekStartsOn(locale)
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2023, 0, 1 + ((start + i) % 7)))))
}
