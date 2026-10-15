/**
 * Transactional email bodies. Pure — every function takes data and returns
 * `{subject, html, text}`, so the queue consumer decides when to send and this
 * file only decides what it says.
 *
 * Two rules run through all of it:
 *
 * 1. TIMEZONE. Every time is rendered in the RECIPIENT's zone with its offset
 *    label. A guest in Kyiv and a host in New York get different strings for
 *    the same instant, and both are right. Emails that render "the host's
 *    time" to a guest are the single largest source of missed meetings, which
 *    is why the audience is an explicit argument rather than a default.
 *
 * 2. ESCAPING. `guestName`, answers and event titles are attacker-controlled —
 *    a booking page is a public, unauthenticated form. Everything interpolated
 *    into HTML goes through `escapeHtml`, and anything reaching a header goes
 *    through `sanitizeHeader`.
 *
 * The HTML is deliberately old-fashioned: table layout, inline styles only, no
 * <style> block, no flexbox or grid. Outlook's Word rendering engine drops
 * modern CSS silently, and "silently" means a confirmation that looks broken to
 * exactly the corporate recipients least willing to forgive it. Max width is
 * 600px, the widest that survives every preview pane.
 */

import type { Booking, EventType, User } from './domain/types.js'
import { answeredQuestions } from './domain/booking-service.js'
import { describeLocation } from './ics.js'
import { formatInZone, offsetLabel } from './time/zone.js'
import { intlTag, t, type Locale, type MessageKey } from './i18n/index.js'

export interface EmailContent {
  subject: string
  html: string
  text: string
  /**
   * Where a reply should go. Set on guest mail to the host's address: the
   * Worker's sender is a no-reply identity, and a guest who answers a
   * confirmation is writing to the person they booked. The sender wiring
   * (notify.ts) copies it onto the queued message's `replyTo`.
   */
  replyTo?: string
}

export type EmailAudience = 'guest' | 'host'

export interface BookingEmailContext {
  booking: Booking
  eventType: EventType
  /** The primary host — whose timezone host-facing mail is rendered in. */
  host: User
  /** All participating hosts for a collective event. Defaults to `[host]`. */
  hosts?: User[]
  brandName?: string
  /** Guest manage links (ADR-0005 §4). Omitted when the booking is in the past. */
  rescheduleUrl?: string
  cancelUrl?: string
  /** Host-facing deep link into the dashboard. */
  bookingUrl?: string
  supportEmail?: string
  /**
   * The deployment's own origin — needed to build an absolute
   * `/avatars/:key` URL for the host's photo. Optional: absent, the guest
   * confirmation simply renders without one, same as a host with no photo
   * uploaded. Email images must always be absolute (unlike the booking page,
   * which can use a relative `/avatars/:key`), because a mail client has no
   * document base URL to resolve a relative one against.
   */
  baseUrl?: string
  /**
   * Whether the .ics is actually attached to THIS send. Defaults to true —
   * every real call site passes it explicitly (notify.ts knows whether
   * `buildAttachment` produced one) — because a booking whose generated .ics
   * exceeded the 40 KB attachment cap, or whose generation failed outright,
   * still gets sent without one, and the copy must not claim otherwise.
   */
  hasAttachment?: boolean
  /**
   * The language of GUEST mail (`bookings.guest_locale`, wired by the caller).
   * Host-facing mail ignores it: the dashboard and its mail stay English.
   */
  locale?: Locale
  /**
   * Host mail only: when the same guest already has an upcoming booking with
   * this host (`findOtherUpcomingGuestBooking`), the host is told in the intro.
   */
  priorBookingStartUtc?: number
}

// Brand palette (swayq-2026 light tokens). Inline hex rather than tokens:
// email has no cascade and no custom properties, so every colour has to
// travel with the element. Learning Lime is a fill behind carbon ink, never
// text; the wordmark period is the same colour as the letters.
const INK = '#0E0E0E'
const MUTED = '#4A4A4A'
const PAPER = '#F8F7F5'
const PAPER_DIM = '#EEECE7'
const LINE = '#D9D9D6'
const LIME = '#DBED72'
const MERIDIAN = INK // link colour: carbon, underlined
const DANGER = '#A32116'

const FONT = "Poppins,-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif"
const MONO = FONT

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * HTML-escape an interpolated value.
 *
 * Ampersand first, or the entities introduced below get their own `&`
 * re-escaped. Quotes are included because these values also land in attributes
 * (`href`, `alt`), where `<` and `>` alone would not be enough.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Strip CR/LF from anything reaching a mail header.
 *
 * A guest name containing a newline would otherwise let a booker inject
 * `Bcc:` into the Subject header of every confirmation we send.
 */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** Only http(s) links become anchors; anything else is rendered as inert text. */
function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null
}

// ---------------------------------------------------------------------------
// Time rendering
// ---------------------------------------------------------------------------

/**
 * `Friday, August 14, 2026, 9:00 AM – 9:30 AM (GMT+3)`.
 *
 * The offset is taken at the START. A meeting that straddles a DST transition
 * has two offsets and no honest single label; the start is the one the reader
 * needs in order to be on time.
 */
export function formatWhen(startUtc: number, endUtc: number, tz: string, locale?: Locale): string {
  // Host mail (no locale) stays en-US; guest mail always passes one.
  const lt = locale ? intlTag(locale) : 'en-US'
  const date = formatInZone(startUtc, tz, { dateStyle: 'full' }, lt)
  const from = formatInZone(startUtc, tz, { timeStyle: 'short' }, lt)
  const to = formatInZone(endUtc, tz, { timeStyle: 'short' }, lt)
  return `${date}, ${from} – ${to} (${offsetLabel(startUtc, tz)})`
}

/** Guest wording: the same, with the zone NAMED, not just offset: `(Europe/Copenhagen, GMT+2)`. */
function formatWhenForGuest(startUtc: number, endUtc: number, tz: string, locale: Locale): string {
  const lt = intlTag(locale)
  const date = formatInZone(startUtc, tz, { dateStyle: 'full' }, lt)
  const from = formatInZone(startUtc, tz, { timeStyle: 'short' }, lt)
  const to = formatInZone(endUtc, tz, { timeStyle: 'short' }, lt)
  return `${date}, ${from} – ${to} (${tz.replace(/_/g, ' ')}, ${offsetLabel(startUtc, tz)})`
}

/** Compact form for subject lines, where the full date eats the preview pane. */
function formatWhenShort(startUtc: number, tz: string, locale?: Locale): string {
  return `${formatInZone(startUtc, tz, { dateStyle: 'medium', timeStyle: 'short' }, locale ? intlTag(locale) : 'en-US')} (${offsetLabel(startUtc, tz)})`
}

/** The zone the recipient reads in — the whole point of the audience argument. */
function zoneFor(ctx: BookingEmailContext, audience: EmailAudience): string {
  return audience === 'guest' ? ctx.booking.guestTimezone : ctx.host.tz
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

interface DetailRow {
  label: string
  value: string
  /** Rendered as a link when it is an http(s) URL. */
  href?: string
  strike?: boolean
}

interface Cta {
  label: string
  url: string
  /** The single primary action gets the green button; the rest are text links. */
  primary?: boolean
}

interface ShellInput {
  brandName: string
  /** The line inbox lists show after the subject. */
  preheader: string
  heading: string
  intro: string
  rows: DetailRow[]
  ctas: Cta[]
  /** Small print under the divider — timezone caveats, security notes. */
  notes?: string[]
  accent?: string
  /**
   * The host's photo — optional decorative content, unlike the
   * text wordmark above it. A host photo failing to load leaves the
   * confirmation fully legible (name, time, location are all still plain
   * text), which is a different bar than the wordmark's "never an image at
   * all" rule in this file's header comment: Outlook/Gmail blocking images
   * by default would hide a load-bearing wordmark, but merely omits a nice-
   * to-have photo here.
   */
  avatarUrl?: string
  avatarAlt?: string
  /** `<html lang>` and the "Sent by" footer. Defaults to English. */
  locale?: Locale
  replyTo?: string
}

function detailRowHtml(row: DetailRow): string {
  const href = row.href ? safeUrl(row.href) : null
  const style = row.strike
    ? `color:${MUTED};text-decoration:line-through;`
    : `color:${INK};`
  const value = href
    ? `<a href="${escapeHtml(href)}" style="color:${MERIDIAN};text-decoration:underline;">${escapeHtml(row.value)}</a>`
    : escapeHtml(row.value)
  return (
    `<tr>` +
    `<td style="padding:6px 16px 6px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td>` +
    `<td style="padding:6px 0;font-family:${FONT};font-size:15px;line-height:22px;${style}vertical-align:top;">${value}</td>` +
    `</tr>`
  )
}

function onAccent(accent: string): string {
  return accent === LIME ? INK : '#FFFFFF'
}

function ctaHtml(cta: Cta, accent: string): string {
  const href = safeUrl(cta.url)
  if (!href) return ''
  if (!cta.primary) {
    return `<a href="${escapeHtml(href)}" style="font-family:${FONT};font-size:14px;color:${MERIDIAN};text-decoration:underline;margin-right:20px;">${escapeHtml(cta.label)}</a>`
  }
  // Table-wrapped button: padding on an <a> is unreliable in Outlook, padding
  // on a <td> is not.
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">` +
    `<tr><td bgcolor="${accent}" style="border-radius:10px;">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:${onAccent(accent)};text-decoration:none;border-radius:10px;">${escapeHtml(cta.label)}</a>` +
    `</td></tr></table>`
  )
}

function shell(input: ShellInput): string {
  const accent = input.accent ?? LIME
  const locale = input.locale ?? 'en'
  const rows = input.rows.map(detailRowHtml).join('')
  const primary = input.ctas.filter((c) => c.primary).map((c) => ctaHtml(c, accent)).join('')
  const secondary = input.ctas.filter((c) => !c.primary).map((c) => ctaHtml(c, accent)).join('')
  const notes = (input.notes ?? [])
    .map(
      (n) =>
        `<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(n)}</p>`,
    )
    .join('')

  return (
    // A full document, not a bare fragment: without an explicit charset, a
    // client that ignores (or overrides) the transport's Content-Type header
    // falls back to sniffing, and every en dash and curly quote in this file
    // turns to mojibake (`–` becomes `â€"`). `color-scheme`/`supported-color-
    // schemes` are the one dark-mode hook that survives clients stripping
    // `<style>` blocks — they ask Apple Mail/Outlook.com to leave this light
    // design alone instead of auto-inverting it into unreadable pairings.
    `<!doctype html><html lang="${locale}"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge">` +
    `<meta name="color-scheme" content="light">` +
    `<meta name="supported-color-schemes" content="light">` +
    `</head><body style="margin:0;padding:0;background-color:${PAPER};" bgcolor="${PAPER}">` +
    // Hidden preheader: what the inbox shows next to the subject. Without it,
    // clients scrape the first visible text, which here is the wordmark.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAPER};margin:0;padding:0;">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background-color:#FFFFFF;border:1px solid ${LINE};border-radius:16px;">` +
    // Wordmark as text, not an image: images are blocked by default in Outlook
    // and Gmail, and a confirmation must not open on a broken placeholder.
    `<tr><td style="padding:24px 28px 8px 28px;font-family:${MONO};font-size:16px;font-weight:600;letter-spacing:-0.02em;color:${INK};">` +
    `${escapeHtml(input.brandName.toLowerCase().replace(/\s+/g, ''))}<span>.</span>` +
    `</td></tr>` +
    // The host photo, unlike the wordmark above: optional, decorative, an
    // <img> with real alt text. If it fails to load the row still reserves
    // no meaningful space and every fact below (name, time, location) is
    // plain text, so the email stays fully legible either way.
    (input.avatarUrl
      ? `<tr><td style="padding:8px 28px 0 28px;">` +
        `<img src="${escapeHtml(input.avatarUrl)}" width="40" height="40" alt="${escapeHtml(input.avatarAlt ?? '')}" ` +
        `style="width:40px;height:40px;border-radius:50%;display:block;object-fit:cover;">` +
        `</td></tr>`
      : '') +
    `<tr><td style="padding:8px 28px 0 28px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;color:${INK};">${escapeHtml(input.heading)}</td></tr>` +
    `<tr><td style="padding:12px 28px 0 28px;font-family:${FONT};font-size:15px;line-height:23px;color:${INK};">${escapeHtml(input.intro)}</td></tr>` +
    `<tr><td style="padding:20px 28px 0 28px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${PAPER_DIM};border-radius:10px;">` +
    `<tr><td style="padding:16px 18px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">${rows}</table>` +
    `</td></tr></table></td></tr>` +
    (primary ? `<tr><td style="padding:22px 28px 0 28px;">${primary}</td></tr>` : '') +
    // Bottom padding matters here: the notes block below starts with a
    // border-top, and without it the rule sits directly under the link text.
    (secondary ? `<tr><td style="padding:4px 28px 20px 28px;">${secondary}</td></tr>` : '') +
    (notes
      ? `<tr><td style="padding:22px 28px 24px 28px;border-top:1px solid ${LINE};">${notes}</td></tr>`
      : `<tr><td style="padding:24px;"></td></tr>`) +
    `</table>` +
    `<div style="font-family:${FONT};font-size:11px;line-height:18px;color:${MUTED};padding:14px 8px 0 8px;">${escapeHtml(t(locale, 'email.sentBy', { brand: input.brandName }))}</div>` +
    `</td></tr></table>` +
    `</body></html>`
  )
}

/**
 * The plain-text alternative, written rather than derived.
 *
 * Stripping tags out of the HTML produces something technically present and
 * practically unreadable; plenty of people (and every accessibility tool that
 * prefers text/plain) read this version and nothing else.
 */
function plain(input: ShellInput): string {
  const out: string[] = [input.heading, '', input.intro, '']
  for (const r of input.rows) {
    out.push(`${r.label}: ${r.strike ? `(was) ${r.value}` : r.value}`)
  }
  if (input.ctas.length > 0) {
    out.push('')
    for (const c of input.ctas) {
      const href = safeUrl(c.url)
      if (href) out.push(`${c.label}: ${href}`)
    }
  }
  for (const n of input.notes ?? []) out.push('', n)
  out.push('', input.brandName)
  return out.join('\n')
}

function render(input: ShellInput, subject: string): EmailContent {
  return {
    subject: sanitizeHeader(subject),
    html: shell(input),
    text: plain(input),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  }
}

// ---------------------------------------------------------------------------
// Shared booking details
// ---------------------------------------------------------------------------

function hostNames(ctx: BookingEmailContext): string {
  const all = ctx.hosts && ctx.hosts.length > 0 ? ctx.hosts : [ctx.host]
  return all.map((h) => h.name).join(', ')
}

/**
 * `hostNames` plus a job title and company, ONLY for the single-host case —
 * a team event's "Host: Alice, Bob" row has nowhere unambiguous to attach
 * one person's identity, so this deliberately doesn't attempt it there.
 * Signature style: "Grace Hopper, CEO, Acme Inc", either half optional.
 */
function hostNamesWithCompany(ctx: BookingEmailContext): string {
  const all = ctx.hosts && ctx.hosts.length > 0 ? ctx.hosts : [ctx.host]
  if (all.length !== 1) return hostNames(ctx)
  const host = all[0]!
  return [host.name, host.jobTitle, host.company].filter((p): p is string => !!p).join(', ')
}

function answerRows(ctx: BookingEmailContext): DetailRow[] {
  return answeredQuestions(ctx.eventType, ctx.booking.answers).map(({ question, value }) => ({
    label: question.label,
    value,
  }))
}

function baseRows(ctx: BookingEmailContext, audience: EmailAudience, tz: string): DetailRow[] {
  const { booking, eventType } = ctx
  const rows: DetailRow[] = [
    { label: 'What', value: eventType.title },
    { label: 'When', value: formatWhen(booking.startUtc, booking.endUtc, tz) },
    { label: 'Duration', value: `${eventType.durationMinutes} minutes` },
    { label: 'Where', value: describeLocation(eventType, booking.conferenceUrl) },
  ]
  if (audience === 'guest') {
    rows.push({ label: 'Host', value: hostNamesWithCompany(ctx) })
  } else {
    rows.push({ label: 'Guest', value: `${booking.guestName} (${booking.guestEmail})` })
    // The host is told the guest's zone explicitly: it is what makes "9am for
    // you" checkable against what the guest was shown.
    rows.push({ label: 'Guest time', value: formatWhen(booking.startUtc, booking.endUtc, booking.guestTimezone) })
  }
  return [...rows, ...answerRows(ctx)]
}

function manageCtas(ctx: BookingEmailContext, audience: EmailAudience): Cta[] {
  const ctas: Cta[] = []
  if (audience === 'guest') {
    if (ctx.rescheduleUrl) ctas.push({ label: 'Reschedule', url: ctx.rescheduleUrl, primary: true })
    if (ctx.cancelUrl) ctas.push({ label: 'Cancel', url: ctx.cancelUrl })
  } else if (ctx.bookingUrl) {
    ctas.push({ label: 'View booking', url: ctx.bookingUrl, primary: true })
  }
  return ctas
}

function tzNote(tz: string, startUtc: number): string {
  // Same humanization as the timezone picker on the booking page (booking.ts)
  // — the raw IANA id's underscore reads as a system identifier, not a place,
  // in a sentence meant for a guest.
  return `All times shown in ${tz.replace(/_/g, ' ')} (${offsetLabel(startUtc, tz)}).`
}

function supportNote(ctx: BookingEmailContext): string[] {
  return ctx.supportEmail ? [`Questions? Reply to this email or write to ${ctx.supportEmail}.`] : []
}

function brandOf(ctx: BookingEmailContext): string {
  return ctx.brandName ?? 'Punctual'
}

const guestLocale = (ctx: BookingEmailContext): Locale => ctx.locale ?? 'en'

/**
 * The management links, as the short guest notes carry them. The invitation
 * itself comes from Google (sendUpdates=all), so this mail says what was
 * booked and how to change it, and nothing more.
 */
function guestCtas(ctx: BookingEmailContext, locale: Locale): Cta[] {
  const ctas: Cta[] = []
  if (ctx.rescheduleUrl) ctas.push({ label: t(locale, 'email.cta.reschedule'), url: ctx.rescheduleUrl, primary: true })
  if (ctx.cancelUrl) ctas.push({ label: t(locale, 'email.cta.cancel'), url: ctx.cancelUrl })
  return ctas
}

/** What was booked: title, host, and the time in the GUEST's zone, with the zone named. */
function guestRows(ctx: BookingEmailContext, locale: Locale): DetailRow[] {
  return [
    { label: t(locale, 'email.row.what'), value: ctx.eventType.title },
    { label: t(locale, 'email.row.host'), value: hostNamesWithCompany(ctx) },
    {
      label: t(locale, 'email.row.when'),
      value: formatWhenForGuest(ctx.booking.startUtc, ctx.booking.endUtc, ctx.booking.guestTimezone, locale),
    },
    // Where it happens still belongs in the note: the Meet link only exists
    // once the calendar sync has run, and a phone number or an address never
    // comes from Google.
    { label: t(locale, 'email.row.where'), value: describeLocation(ctx.eventType, ctx.booking.conferenceUrl) },
  ]
}

/** Replies reach the host, not a no-reply sender. */
function hostReplyTo(ctx: BookingEmailContext): { replyTo?: string } {
  return ctx.host.email ? { replyTo: ctx.host.email } : {}
}

function guestNotes(ctx: BookingEmailContext, locale: Locale, invitationKey: MessageKey): string[] {
  return [
    t(locale, invitationKey),
    t(locale, 'email.replyNote', { host: hostNames(ctx) }),
  ]
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function bookingConfirmationForGuest(ctx: BookingEmailContext): EmailContent {
  // A short note: the calendar invitation is Google's. This mail is the
  // record of what was booked plus the two management links, in the guest's
  // language, replying to the host.
  const tz = zoneFor(ctx, 'guest')
  const locale = guestLocale(ctx)
  const host = hostNames(ctx)
  const input: ShellInput = {
    brandName: brandOf(ctx),
    locale,
    preheader: `${ctx.eventType.title} · ${formatWhenShort(ctx.booking.startUtc, tz, locale)}`,
    heading: t(locale, 'email.confirmed.heading'),
    intro: t(locale, 'email.confirmed.intro', { guest: ctx.booking.guestName, host }),
    rows: guestRows(ctx, locale),
    ctas: guestCtas(ctx, locale),
    notes: guestNotes(ctx, locale, 'email.invitationNote'),
    ...hostReplyTo(ctx),
  }
  return render(
    input,
    t(locale, 'email.confirmed.subject', {
      event: ctx.eventType.title,
      host,
      when: formatWhenShort(ctx.booking.startUtc, tz, locale),
    }),
  )
}

export function bookingConfirmationForHost(ctx: BookingEmailContext): EmailContent {
  const tz = zoneFor(ctx, 'host')
  const brandName = brandOf(ctx)
  const input: ShellInput = {
    brandName,
    preheader: `${ctx.booking.guestName} — ${formatWhenShort(ctx.booking.startUtc, tz)}`,
    heading: 'New booking',
    // The same .ics that lands the guest's copy is attached here too — worth
    // saying, since not every calendar is connected for auto-sync and a host
    // whose client doesn't auto-detect the attachment needs to know it's there.
    // Conditional on `hasAttachment`: a .ics that exceeded the size cap, or
    // failed to generate, is dropped before the email is (notify.ts) — this
    // copy must not claim an attachment that was never actually sent.
    intro:
      (ctx.hasAttachment === false
        ? `${ctx.booking.guestName} booked ${ctx.eventType.title}. It is already on your calendar.`
        : `${ctx.booking.guestName} booked ${ctx.eventType.title}. It is already on your calendar — the invite is attached too, in case you need it elsewhere.`) +
      (ctx.priorBookingStartUtc !== undefined
        ? ` ${t('en', 'email.host.priorBooking', {
            date: formatInZone(ctx.priorBookingStartUtc, tz, { dateStyle: 'full' }),
          })}`
        : ''),
    rows: baseRows(ctx, 'host', tz),
    ctas: manageCtas(ctx, 'host'),
    notes: [tzNote(tz, ctx.booking.startUtc)],
  }
  return render(
    input,
    `New booking: ${ctx.eventType.title} with ${ctx.booking.guestName} — ${formatWhenShort(ctx.booking.startUtc, tz)}`,
  )
}

export interface RescheduleEmailContext extends BookingEmailContext {
  audience: EmailAudience
  /** The times the booking used to have. Rendered struck through. */
  previous: { startUtc: number; endUtc: number }
}

/**
 * The .ics accompanying this mail must reuse the ORIGINAL UID with a bumped
 * SEQUENCE (see `core/ics.ts`), or the recipient ends up holding both the old
 * and the new meeting.
 */
export function bookingRescheduled(ctx: RescheduleEmailContext): EmailContent {
  return ctx.audience === 'guest' ? rescheduledForGuest(ctx) : rescheduledForHost(ctx)
}

function rescheduledForHost(ctx: RescheduleEmailContext): EmailContent {
  const tz = zoneFor(ctx, ctx.audience)
  const brandName = brandOf(ctx)
  const rows = baseRows(ctx, ctx.audience, tz)
  // The old time sits directly under the new one: the reader's actual question
  // is "did it move off the slot I blocked out?", and two adjacent lines answer
  // it faster than a paragraph.
  rows.splice(2, 0, {
    label: 'Previously',
    value: formatWhen(ctx.previous.startUtc, ctx.previous.endUtc, tz),
    strike: true,
  })
  const who = ctx.audience === 'guest' ? hostNames(ctx) : ctx.booking.guestName
  const input: ShellInput = {
    brandName,
    preheader: `New time: ${formatWhenShort(ctx.booking.startUtc, tz)}`,
    heading: 'Your meeting moved',
    intro:
      ctx.audience === 'guest'
        ? ctx.hasAttachment === false
          ? `Your meeting with ${who} has a new time.`
          : `Your meeting with ${who} has a new time. The updated invite is attached and replaces the old one — no need to delete anything.`
        : ctx.hasAttachment === false
          ? `${who} rescheduled. Your calendar has been updated automatically.`
          : `${who} rescheduled. Your calendar has been updated automatically, and the updated invite is attached too.`,
    rows,
    ctas: manageCtas(ctx, ctx.audience),
    notes: [
      tzNote(tz, ctx.booking.startUtc),
      // ADR-0005 §4: rescheduling rotates the manage token, so links in the
      // superseded confirmation are dead. Saying so prevents a support ticket.
      'Links in the earlier confirmation no longer work — use the ones above.',
      ...supportNote(ctx),
    ],
  }
  return render(input, `Rescheduled: ${ctx.eventType.title} — ${formatWhenShort(ctx.booking.startUtc, tz)}`)
}

function rescheduledForGuest(ctx: RescheduleEmailContext): EmailContent {
  const tz = zoneFor(ctx, 'guest')
  const locale = guestLocale(ctx)
  const host = hostNames(ctx)
  const rows = guestRows(ctx, locale)
  // The old time sits directly under the new one, struck through.
  rows.splice(3, 0, {
    label: t(locale, 'email.row.previously'),
    value: formatWhenForGuest(ctx.previous.startUtc, ctx.previous.endUtc, tz, locale),
    strike: true,
  })
  const input: ShellInput = {
    brandName: brandOf(ctx),
    locale,
    preheader: formatWhenShort(ctx.booking.startUtc, tz, locale),
    heading: t(locale, 'email.rescheduled.heading'),
    intro: t(locale, 'email.rescheduled.intro', { guest: ctx.booking.guestName, host }),
    rows,
    ctas: guestCtas(ctx, locale),
    // ADR-0005 §4: rescheduling rotates the manage token, so links in the
    // superseded confirmation are dead. Saying so prevents a support ticket.
    notes: [...guestNotes(ctx, locale, 'email.updatedInvitationNote'), t(locale, 'email.oldLinks')],
    ...hostReplyTo(ctx),
  }
  return render(
    input,
    t(locale, 'email.rescheduled.subject', {
      event: ctx.eventType.title,
      host,
      when: formatWhenShort(ctx.booking.startUtc, tz, locale),
    }),
  )
}

export interface CancellationEmailContext extends BookingEmailContext {
  audience: EmailAudience
  cancelledBy?: EmailAudience
  /** The one host who cancelled, when `cancelledBy` is 'host' and it is known; otherwise every host is named. */
  cancelledByName?: string
  reason?: string
  /** Where the guest can pick a new time. */
  rebookUrl?: string
}

function cancelledForGuest(ctx: CancellationEmailContext): EmailContent {
  const tz = zoneFor(ctx, 'guest')
  const locale = guestLocale(ctx)
  const host = hostNames(ctx)
  const reason = ctx.reason?.trim() ?? ''
  const by =
    ctx.cancelledBy === 'host'
      ? ctx.cancelledByName ?? host
      : ctx.cancelledBy === 'guest'
        ? ctx.booking.guestName
        : null
  const rows = guestRows(ctx, locale)
  if (reason !== '' && !by) rows.push({ label: t(locale, 'email.row.reason'), value: reason })
  const event = ctx.eventType.title
  const intro = by
    ? reason !== ''
      ? t(locale, 'email.cancelled.byWithReason', { by, event, reason })
      : t(locale, 'email.cancelled.by', { by, event })
    : t(locale, 'email.cancelled.plain', { event })
  const input: ShellInput = {
    brandName: brandOf(ctx),
    locale,
    // Red only as the accent, and only here: cancellation is the one state
    // where "lime means go" must not apply.
    accent: DANGER,
    preheader: `${event} · ${formatWhenShort(ctx.booking.startUtc, tz, locale)}`,
    heading: t(locale, 'email.cancelled.heading'),
    intro,
    rows,
    ctas: ctx.rebookUrl ? [{ label: t(locale, 'email.cta.bookAgain'), url: ctx.rebookUrl, primary: true }] : [],
    notes: [t(locale, 'email.replyNote', { host })],
    ...hostReplyTo(ctx),
  }
  return render(input, t(locale, 'email.cancelled.subject', { event, host }))
}

export function bookingCancelled(ctx: CancellationEmailContext): EmailContent {
  return ctx.audience === 'guest' ? cancelledForGuest(ctx) : cancelledForHost(ctx)
}

function cancelledForHost(ctx: CancellationEmailContext): EmailContent {
  const tz = zoneFor(ctx, ctx.audience)
  const brandName = brandOf(ctx)
  const rows = baseRows(ctx, ctx.audience, tz)
  const reason = ctx.reason?.trim() ?? ''

  const by =
    ctx.cancelledBy === 'host'
      ? ctx.cancelledByName ?? hostNames(ctx)
      : ctx.cancelledBy === 'guest'
        ? ctx.booking.guestName
        : null
  // A note from whoever cancelled is quoted in the intro, attributed to
  // them — "Alice cancelled … and wrote: …" — because a bare "Reason" row
  // reads as the system's verdict rather than a person's message. Only
  // when nobody is named does it fall back to a row.
  if (reason !== '' && !by) rows.push({ label: 'Reason', value: reason })
  const intro = by
    ? reason !== ''
      ? `${by} cancelled ${ctx.eventType.title} and wrote: “${reason}” It has been removed from the calendar.`
      : `${by} cancelled ${ctx.eventType.title}. It has been removed from the calendar.`
    : `${ctx.eventType.title} has been cancelled and removed from the calendar.`
  const input: ShellInput = {
    brandName,
    // Red only here, and only as the accent: cancellation is the one state
    // where the brand's discipline rule (green means confirmed) must not apply.
    accent: DANGER,
    preheader: `${ctx.eventType.title} — ${formatWhenShort(ctx.booking.startUtc, tz)}`,
    heading: 'This meeting was cancelled',
    intro,
    rows,
    ctas: ctx.rebookUrl ? [{ label: 'Book a new time', url: ctx.rebookUrl, primary: true }] : [],
    notes: [tzNote(tz, ctx.booking.startUtc), ...supportNote(ctx)],
  }
  return render(input, `Cancelled: ${ctx.eventType.title} — ${formatWhenShort(ctx.booking.startUtc, tz)}`)
}

export interface ReminderEmailContext extends BookingEmailContext {
  audience: EmailAudience
  when: '24h' | '1h'
}

function reminderForGuest(ctx: ReminderEmailContext): EmailContent {
  const tz = zoneFor(ctx, 'guest')
  const locale = guestLocale(ctx)
  const host = hostNames(ctx)
  const event = ctx.eventType.title
  const n = ctx.when === '24h' ? '24' : '1'
  const when = formatWhenShort(ctx.booking.startUtc, tz, locale)
  const input: ShellInput = {
    brandName: brandOf(ctx),
    locale,
    preheader: `${event} · ${when}`,
    heading: t(locale, `email.reminder.heading${n}` as MessageKey),
    intro: t(locale, `email.reminder.intro${n}` as MessageKey, { event, host }),
    rows: guestRows(ctx, locale),
    ctas: guestCtas(ctx, locale),
    notes: [t(locale, 'email.replyNote', { host })],
    ...hostReplyTo(ctx),
  }
  return render(input, t(locale, `email.reminder.subject${n}` as MessageKey, { event, when }))
}

export function bookingReminder(ctx: ReminderEmailContext): EmailContent {
  return ctx.audience === 'guest' ? reminderForGuest(ctx) : reminderForHost(ctx)
}

function reminderForHost(ctx: ReminderEmailContext): EmailContent {
  const tz = zoneFor(ctx, ctx.audience)
  const brandName = brandOf(ctx)
  const lead = ctx.when === '24h' ? 'tomorrow' : 'in an hour'
  const who = ctx.audience === 'guest' ? hostNames(ctx) : ctx.booking.guestName
  const input: ShellInput = {
    brandName,
    preheader: `${ctx.eventType.title} ${lead} — ${formatWhenShort(ctx.booking.startUtc, tz)}`,
    heading: ctx.when === '24h' ? 'Your meeting is tomorrow' : 'Your meeting starts in an hour',
    intro: `A reminder that ${ctx.eventType.title} with ${who} starts ${lead}.`,
    rows: baseRows(ctx, ctx.audience, tz),
    ctas: manageCtas(ctx, ctx.audience),
    notes: [tzNote(tz, ctx.booking.startUtc), ...supportNote(ctx)],
  }
  const prefix = ctx.when === '24h' ? 'Tomorrow' : 'In 1 hour'
  return render(input, `${prefix}: ${ctx.eventType.title} — ${formatWhenShort(ctx.booking.startUtc, tz)}`)
}

export interface HostAddedInput {
  brandName: string
  hostName: string
  eventTitle: string
  teamName: string
  schedulingType: 'round_robin' | 'collective'
  /** Collective only: whether the host is required. */
  required: boolean
  /** The schedule the admin picked for them, or null for their default. */
  scheduleName: string | null
  /** Who did it — named, so the email is not an anonymous system notice. */
  editorName: string
  availabilityUrl: string
  supportEmail?: string
}

/**
 * "You're a host on …" — sent when a team admin puts someone on an event
 * type. The one thing it must carry is which of the host's schedules the
 * slots will come from, and where to change that: an admin arranging
 * availability on someone's behalf is exactly the case where the host
 * needs to be told.
 */
export function hostAddedEmail(input: HostAddedInput): EmailContent {
  const attendance =
    input.schedulingType === 'collective'
      ? input.required
        ? 'Required — slots are offered only when you are free'
        : 'Optional — you join a booking when you are free'
      : 'Round robin — bookings rotate among the hosts'
  const shellInput: ShellInput = {
    brandName: input.brandName,
    preheader: `${input.editorName} added you as a host on ${input.eventTitle}.`,
    heading: `You're a host on ${input.eventTitle}`,
    intro: `${input.editorName} added you as a host on "${input.eventTitle}", a ${input.teamName} event type. Slots use ${input.scheduleName ? `your "${input.scheduleName}" schedule` : 'your default schedule'}.`,
    rows: [
      { label: 'Team', value: input.teamName },
      { label: 'Attendance', value: attendance },
      { label: 'Your schedule', value: input.scheduleName ?? 'Default' },
    ],
    ctas: [{ label: 'Review your availability', url: input.availabilityUrl, primary: true }],
    notes: [
      'You can change which of your schedules this event type uses, or edit the schedule itself, at any time.',
      ...(input.supportEmail ? [`Questions? Write to ${input.supportEmail}.`] : []),
    ],
  }
  return render(shellInput, `You're a host on ${input.eventTitle}`)
}

export interface BookingHostChangeInput {
  brandName: string
  /** The recipient — the host being put on or taken off the booking. */
  hostName: string
  /** The recipient's zone: the time is rendered for them, not for the editor. */
  hostTz: string
  eventTitle: string
  guestName: string
  guestEmail: string
  startUtc: number
  endUtc: number
  /** The hosts as they stand AFTER the change, by name. */
  hostNames: string[]
  /** Who made the change — named, so it is not an anonymous system notice. */
  editorName: string
  bookingUrl: string
  supportEmail?: string
}

function bookingHostChangeRows(input: BookingHostChangeInput): DetailRow[] {
  return [
    { label: 'When', value: formatWhen(input.startUtc, input.endUtc, input.hostTz) },
    { label: 'Guest', value: `${input.guestName} (${input.guestEmail})` },
    { label: 'Event', value: input.eventTitle },
    { label: 'Hosts', value: input.hostNames.join(', ') },
  ]
}

/**
 * "You've been added to a booking" — to a host put on an EXISTING booking
 * after the fact. Unlike `hostAddedEmail` this is one specific meeting at
 * one specific time, so the time and the guest are the body of it; the
 * dashboard link is where the host reads the rest.
 */
export function hostAddedToBookingEmail(input: BookingHostChangeInput): EmailContent {
  const shellInput: ShellInput = {
    brandName: input.brandName,
    preheader: `${input.editorName} added you to ${input.eventTitle} with ${input.guestName}.`,
    heading: `You've been added to a booking`,
    intro: `${input.editorName} added you as a host on "${input.eventTitle}" with ${input.guestName}. The calendar invitation follows separately.`,
    rows: bookingHostChangeRows(input),
    ctas: [{ label: 'Open the booking', url: input.bookingUrl, primary: true }],
    notes: [
      tzNote(input.hostTz, input.startUtc),
      ...(input.supportEmail ? [`Questions? Write to ${input.supportEmail}.`] : []),
    ],
  }
  return render(shellInput, `You've been added: ${input.eventTitle} with ${input.guestName}, ${formatWhenShort(input.startUtc, input.hostTz)}`)
}

/**
 * "You've been taken off a booking" — the mirror of the above. Says who
 * still hosts, because the reader's first question is whether the meeting
 * is covered without them.
 */
export function hostRemovedFromBookingEmail(input: BookingHostChangeInput): EmailContent {
  const shellInput: ShellInput = {
    brandName: input.brandName,
    preheader: `${input.editorName} took you off ${input.eventTitle} with ${input.guestName}.`,
    heading: `You've been taken off a booking`,
    intro: `${input.editorName} took you off "${input.eventTitle}" with ${input.guestName}. The meeting goes ahead with the hosts below; nothing is expected of you.`,
    rows: bookingHostChangeRows(input),
    ctas: [{ label: 'Open the booking', url: input.bookingUrl }],
    notes: [
      'If the meeting is still on your calendar, you can decline or remove it — the booking itself no longer lists you.',
      tzNote(input.hostTz, input.startUtc),
      ...(input.supportEmail ? [`Questions? Write to ${input.supportEmail}.`] : []),
    ],
  }
  return render(shellInput, `You've been taken off: ${input.eventTitle} with ${input.guestName}, ${formatWhenShort(input.startUtc, input.hostTz)}`)
}

export interface MagicLinkInput {
  url: string
  /** The IP that asked for the link. ADR-0005 §3 requires it in the body. */
  ip: string
  userAgent: string
  expiresMinutes: number
  brandName?: string
  supportEmail?: string
}

/**
 * The sign-in link.
 *
 * ADR-0005 §3 requires the requesting IP and user agent in the email: the link
 * is a bearer credential delivered to an inbox, so the recipient is the only
 * party who can tell a login they started from one they did not. Both values
 * come off an untrusted request — the user agent in particular is a raw header
 * — hence the escaping and the length cap.
 */
export function magicLinkEmail(input: MagicLinkInput): EmailContent {
  const brandName = input.brandName ?? 'Punctual'
  const shellInput: ShellInput = {
    brandName,
    preheader: `Your sign-in link expires in ${input.expiresMinutes} minutes.`,
    heading: `Sign in to ${brandName}`,
    intro: `Click the button below to sign in. The link works once and expires in ${input.expiresMinutes} minutes.`,
    rows: [
      { label: 'Requested from', value: input.ip || 'unknown' },
      { label: 'Device', value: (input.userAgent || 'unknown').slice(0, 200) },
    ],
    ctas: [{ label: 'Sign in', url: input.url, primary: true }],
    notes: [
      'If you did not request this, ignore this email — the link expires on its own and nothing changes until it is used.',
      ...(input.supportEmail ? [`Something looks wrong? Write to ${input.supportEmail}.`] : []),
    ],
  }
  // `plain()` already emits the raw URL under its label, which is what a client
  // that mangles the button falls back to.
  return render(shellInput, `Sign in to ${brandName}`)
}

// ---------------------------------------------------------------------------
// The morning digest (core/domain/digest.ts)
// ---------------------------------------------------------------------------

export interface DigestEmailInput {
  brandName: string
  supportEmail?: string
  host: User
  /** Host-local date, YYYY-MM-DD. */
  date: string
  meetings: Array<{ booking: Booking; eventType: EventType; coHosts: User[] }>
  dashboardUrl: string
}

export function dailyDigestEmail(input: DigestEmailInput): EmailContent {
  const tz = input.host.tz
  const n = input.meetings.length
  // From the digest's own date, not the first meeting's start: a meeting
  // that began before midnight must not relabel the day (caught by review).
  const [y, mo, d] = input.date.split('-').map(Number) as [number, number, number]
  const dayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, d)))
  const rows: DetailRow[] = input.meetings.map(({ booking, eventType, coHosts }) => ({
    label: formatInZone(booking.startUtc, tz, { hour: 'numeric', minute: '2-digit' }),
    value: `${eventType.title} — ${booking.guestName}${coHosts.length > 0 ? ` (with ${coHosts.map((u) => u.name || u.slug).join(', ')})` : ''}`,
    href: `${input.dashboardUrl.replace(/\/$/, '')}/bookings/${booking.id}`,
  }))
  const shellInput: ShellInput = {
    brandName: input.brandName,
    preheader: `${n} ${n === 1 ? 'meeting' : 'meetings'} today`,
    heading: `Today: ${n} ${n === 1 ? 'meeting' : 'meetings'}`,
    intro: `${dayLabel}. Your confirmed meetings, in ${tz}.`,
    rows,
    ctas: [{ label: 'Open the dashboard', url: input.dashboardUrl, primary: true }],
    notes: [
      'You get this because you turned on the morning digest under Settings; turn it off there any time.',
      ...(input.supportEmail ? [`Questions? Write to ${input.supportEmail}.`] : []),
    ],
  }
  return render(shellInput, `Today: ${n} ${n === 1 ? 'meeting' : 'meetings'} — ${dayLabel}`)
}
