/**
 * The public booking page (spec §5.1, ADR-0007 §3).
 *
 * Server-rendered strings rather than a component framework: the §7 budget is
 * <100 ms TTFB and <80 KB gzip, and the interaction model — pick a day, pick a
 * slot, fill a form — is three navigations, not an application.
 *
 * The page is session-free by design (ADR-0005 §5). It carries no cookie and
 * no ambient authority, which is what lets the dashboard cookie stay
 * SameSite=Lax while this page is embedded cross-origin in an iframe.
 *
 * Streaming: `shellHead` is flushed before any D1 read so TTFB is a function of
 * edge render, not of a replica round trip. We also hold a time-to-first-slot
 * budget (<400 ms) precisely so that flushing early cannot flatter the number
 * while the page is still useless (ADR-0007 §3).
 */

import type { ResolvedHost } from '../../core/domain/hosts.js'
import { fitKeyFor, type LogoShape } from '../../core/domain/media.js'
import type { CompanyLogo,
  Team, EventType, Slot, User } from '../../core/domain/types.js'
import { AGENDA_QUESTION, effectiveQuestions } from '../../core/domain/booking-service.js'
import { slotStateClassName } from '../../core/slot-state.js'
import { localDateString, offsetLabel } from '../../core/time/zone.js'
import { embedResizeScriptTag } from '../embed.js'
import { pageCss } from '../styles.js'
import { guestPageCss, SWAYQ_FONT_FILES, SWAYQ_PAGE } from '../swayq-skin.js'
import { SWAYQ_SURFACES } from '../../swayq-surfaces.js'
import {
  formatDateTime,
  formatLocalDate,
  formatMonthYear,
  formatWhenLong,
  t,
  tHtml,
  weekdayNames,
  weekStartsOn,
  type Locale,
} from '../../core/i18n/index.js'

/**
 * The wordmark in a public-facing footer always points here, not at `/` —
 * on a self-hosted install, `/` is that operator's own homepage, and a
 * curious guest clicking "punctual:" wants the project, not another loop
 * back into the same deployment they're already looking at.
 */
export const PUNCTUAL_SITE_URL = 'https://punctual.sh'

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface PageChrome {
  title: string
  description?: string
  brandName: string
  themeColor?: string
  /**
   * Open Graph / Twitter card. Deliberately opt-in, not automatic: a
   * dashboard or guest-manage page carries a session or a guest's own manage
   * token in its URL, and neither should ever be the thing a chat app
   * unfurls a preview for. Only the public booking page passes this.
   *
   * `image` is required, not defaulted, because OG crawlers need an absolute
   * URL and this module has no `baseUrl` of its own to build one from — the
   * caller already has it.
   */
  og?: { url: string; image: string }
  /**
   * The one URL a search engine should index this page under. Absent means
   * NOT INDEXED: the head carries `noindex` instead. Indexing is opt-in for
   * the same reason Open Graph is — a dashboard, a confirm step, a guest's
   * manage link and an embedded copy of the booking page are all reachable
   * by a crawler that follows links, and none of them is a page anyone
   * should find by searching. The public booking page passes its own URL
   * without the `?date=…&tz=…` a crawler found it with, so every variant
   * folds back into one result.
   */
  canonical?: string
  /**
   * A guest-facing page: SwayQ skin (Poppins, light tokens, wordmark), the
   * guest's locale on `<html lang>`, and the EN/DA toggle. Dashboard and
   * marketing pages leave this off and keep upstream's look.
   */
  guest?: boolean
  locale?: Locale
  /** Builds the toggle's link for the OTHER locale; absent on a POST response, where a GET to the same URL would be wrong. */
  langHref?: (locale: Locale) => string
  /**
   * The URL carries a credential (a manage token). No referrer leaves the
   * page, nothing is indexed, and no third-party origin is ever named.
   */
  sensitive?: boolean
  /** Inside the embed iframe: no topbar. */
  embed?: boolean
  /** Extra markup for `<head>`, e.g. the Turnstile script on the confirm form. */
  headExtra?: string
}

/** The EN/DA switch. Plain links: it works with no script, and `aria-current` marks the active one. */
export function langToggleHtml(locale: Locale, langHref: (l: Locale) => string): string {
  const item = (l: Locale): string =>
    l === locale
      ? `<span aria-current="true">${escapeHtml(t(l, l === 'en' ? 'lang.en' : 'lang.da'))}</span>`
      : `<a href="${escapeHtml(langHref(l))}" hreflang="${l}" lang="${l}" rel="nofollow" aria-label="${escapeHtml(t(l, l === 'en' ? 'lang.enName' : 'lang.daName'))}">${escapeHtml(t(l, l === 'en' ? 'lang.en' : 'lang.da'))}</a>`
  return `<nav class="pu-lang" aria-label="${escapeHtml(t(locale, 'lang.label'))}">${item('en')}${item('da')}</nav>`
}

/** `swayq.` — lowercase, one colour: the period is part of the word, never an accent. */
export function wordmarkText(brandName: string): string {
  return `${brandName.toLowerCase().replace(/\s+/g, '')}.`
}

export function wordmarkHtml(brandName: string): string {
  const text = wordmarkText(brandName)
  return `<span class="pu-mark" aria-label="${escapeHtml(brandName)}">${escapeHtml(text.slice(0, -1))}<span>.</span></span>`
}

/**
 * Everything before the first data-dependent byte. Flushed immediately.
 */
export function shellHead(chrome: PageChrome): string {
  const guest = chrome.guest === true
  const locale = chrome.locale ?? 'en'
  const noindex = chrome.sensitive === true || !chrome.canonical
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(chrome.title)}</title>
${chrome.description ? `<meta name="description" content="${escapeHtml(chrome.description)}">` : ''}
<meta name="color-scheme" content="${guest ? 'light' : 'light dark'}">
<meta name="theme-color" content="${chrome.themeColor ?? (guest ? SWAYQ_PAGE : '#0E7C4C')}">
${chrome.sensitive ? '<meta name="referrer" content="no-referrer">' : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${
  noindex
    ? '<meta name="robots" content="noindex">'
    : `<link rel="canonical" href="${escapeHtml(chrome.canonical!)}">`
}
${
  chrome.og
    ? `<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(chrome.brandName)}">
<meta property="og:url" content="${escapeHtml(chrome.og.url)}">
<meta property="og:title" content="${escapeHtml(chrome.title)}">
${chrome.description ? `<meta property="og:description" content="${escapeHtml(chrome.description)}">` : ''}
<meta property="og:image" content="${escapeHtml(chrome.og.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(chrome.title)}">
${chrome.description ? `<meta name="twitter:description" content="${escapeHtml(chrome.description)}">` : ''}
<meta name="twitter:image" content="${escapeHtml(chrome.og.image)}">`
    : ''
}
<!-- Every face the page can use, not just two: with font-display:optional
     the first paint is final, so a face that isn't preloaded is a face the
     visitor likely never sees on a cold cache. Inter carries all body text —
     leaving it out is what made whole pages repaint mid-view. -->
${
  guest
    ? SWAYQ_FONT_FILES.map(
        (f) => `<link rel="preload" href="/fonts/${f}" as="font" type="font/woff2" crossorigin>`,
      ).join('\n')
    : `<link rel="preload" href="/fonts/inter-variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/schibstedgrotesk-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibmplexmono-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibmplexmono-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibmplexmono-700.woff2" as="font" type="font/woff2" crossorigin>`
}
<style>${guest ? guestPageCss() : pageCss()}</style>
${chrome.headExtra ?? ''}
</head>
<body>
<div class="pu-wrap">${
    guest && !chrome.embed
      ? `
<div class="pu-topbar">${wordmarkHtml(chrome.brandName)}${chrome.langHref ? langToggleHtml(locale, chrome.langHref) : ''}</div>`
      : ''
  }`
}

/**
 * `embed` appends the resize postMessage snippet (see `../embed.ts`). Without
 * it the iframe on a customer's page never learns the booking page's real
 * height and stays pinned at `data-height` (default 620px) for the whole
 * multi-step flow.
 *
 * `operator` is the host's company on booking-flow pages (see
 * `displayCompany`). A guest on someone's booking page is dealing with that
 * person's company, not with this software — so the company anchors the
 * footer and the wordmark becomes the attribution, instead of the product
 * tagline fronting a page it doesn't own.
 *
 * No `brandName` parameter: the wordmark below is a fixed "punctual:"
 * attribution to the open-source project (it links to punctual.sh, not this
 * deployment), so a self-hosted `BRAND_NAME` override must NOT retext it —
 * "acme scheduler:" opening punctual.sh instead of Acme's own site would be
 * an unrelated, confusing destination for that click.
 */
export function shellFoot(
  poweredBy = true,
  embed = false,
  operator?: string | null,
  guest?: { locale: Locale; brandName: string },
): string {
  if (guest) {
    // The guest footer carries the deployment's own wordmark, not a link out
    // to the upstream project: a guest on a manage page is holding a token and
    // nothing here should send them (or a referrer) anywhere else.
    const mark = wordmarkHtml(guest.brandName)
    // The company line is dropped when it is just the brand again.
    const showCompany = operator && operator.trim().toLowerCase() !== guest.brandName.trim().toLowerCase()
    const foot = showCompany
      ? `<p class="pu-foot">${tHtml(guest.locale, 'foot.withCompany', { company: escapeHtml(operator), mark })}</p>`
      : `<p class="pu-foot">${tHtml(guest.locale, 'foot.scheduling', { mark })}</p>`
    return `</div>
${poweredBy ? foot : ''}
${embed ? embedResizeScriptTag() : ''}
</body></html>`
  }
  // target="_blank": this page can be embedded in a customer's iframe
  // (`embed`, below), and an external destination navigating the iframe
  // itself in place would either hit the host site's framing restrictions
  // and go blank, or strand the guest on punctual.sh with no way back into
  // the booking flow. A new tab is correct whether embedded or not — this
  // link now leaves the deployment entirely.
  const mark = `<a class="pu-mark" href="${PUNCTUAL_SITE_URL}" target="_blank" rel="noopener">punctual<span>:</span></a>`
  const foot = operator
    ? `<p class="pu-foot">${escapeHtml(operator)} · scheduling by ${mark}</p>`
    : `<p class="pu-foot">${mark} — scheduling that shows up on time</p>`
  return `</div>
${poweredBy ? foot : ''}
${embed ? embedResizeScriptTag() : ''}
</body></html>`
}

/** Placeholder emitted with the shell, replaced when slot data arrives. */
export function slotsSkeleton(locale: Locale = 'en'): string {
  return `<div id="pu-slots" aria-busy="true" aria-live="polite">
  <p class="pu-sr">${escapeHtml(t(locale, 'slots.loading'))}</p>
  ${Array.from({ length: 6 }, () => '<div class="pu-skeleton"></div>').join('\n  ')}
</div>`
}

export interface BookingPageData {
  host: User
  /**
   * The owning team, for a team-owned page. It no longer heads the page:
   * the company logo does, and the team's name (if it chose to show it) is
   * a modest suffix after the hosts' names in `hostsRow`.
   */
  team?: Team | null
  /** The instance's company logo, heading team pages. Absent on a personal page's render, or when none is set. */
  companyLogo?: CompanyLogo | null
  /** The instance's brand name, shown beside a round company logo. */
  brandName?: string
  /**
   * The hosts the guest will meet — the resolved set (core/domain/hosts.ts),
   * in display order, with whether each is required. Rendered by
   * `hostsRow`, separately from the header, because resolving them is a D1
   * read and the header is flushed before any of those (ADR-0007 §3).
   */
  hosts?: ResolvedHost[]
  /**
   * The slug this page is actually reachable at — a user's OR a team's.
   * `host` is a representative user for display/timezone-default purposes
   * only (team-owned event types have no single "owner" user); using
   * `host.slug` for URL generation instead of this field routed every link
   * on a team event's page to a team member's personal page, 404ing there.
   */
  ownerSlug: string
  eventType: EventType
  /** The month being displayed, as a host-local `YYYY-MM`. */
  month: string
  /** Day → whether it has any bookable slot. */
  daysWithSlots: Map<string, boolean>
  selectedDate?: string
  slots?: Slot[]
  guestTimezone: string
  baseUrl: string
  /**
   * Set only on the confirm page, where the timezone picker must post back
   * to `/confirm` with the chosen slot's `start` rather than to the
   * month/day view — the confirm page has no `date`/`month` in its own URL
   * to fall back to, and the day-view form action would otherwise silently
   * discard the guest's already-chosen slot.
   */
  confirmStart?: number
  /** True when served inside the embed iframe (`?embed=1`) — propagated through every internal link so the resize snippet keeps firing past the first navigation. */
  embed?: boolean
  /** The guest's locale. Absent means English, which keeps every pre-i18n caller and test unchanged. */
  locale?: Locale
  /** `?lang=` named the locale: internal links carry it so it survives where the cookie cannot (a third-party iframe). */
  langExplicit?: boolean
  /** Turnstile site key, when the confirm form must carry a challenge. */
  turnstileSiteKey?: string
  /** Colleagues the guest typed, kept when the form is shown again after an error. */
  colleaguesValue?: string
}

const loc = (d: { locale?: Locale }): Locale => d.locale ?? 'en'

/** `&lang=da` for links, only when the locale came from the URL. */
function langQ(d: { locale?: Locale; langExplicit?: boolean }): string {
  return d.langExplicit && d.locale ? `&lang=${d.locale}` : ''
}

/**
 * A `size`×`size` circle: the uploaded avatar/logo thumbnail if the
 * user or team has one, otherwise a CSS-only initials badge so the layout
 * never depends on whether a photo has been uploaded. Shared between the
 * booking page header and the dashboard settings page — the same key served
 * by the same `/avatars/:key` route either way.
 */
/**
 * A logo in the shape its owner chose: `circle` is `avatarHtml` (square
 * crop, round mask); `natural` is the uncropped "-fit" rendering, aligned
 * by height — as wide as its proportions make it, capped at three times
 * the height so a banner cannot push the title off the row. Initials when
 * there is no image, as for avatars.
 */
export function logoHtml(opts: { key: string | null; shape?: LogoShape | null; name: string; size?: number; alt?: string }): string {
  const size = opts.size ?? 40
  // SWAYQ_SURFACES.avatars is off: the R2 route is unmounted, so an <img> would 404. Initials instead.
  if (!SWAYQ_SURFACES.avatars) return avatarHtml({ key: null, name: opts.name, size })
  if (opts.key && opts.shape === 'natural') {
    return `<img src="/avatars/${encodeURIComponent(fitKeyFor(opts.key))}" alt="${escapeHtml(opts.alt ?? opts.name)}" height="${size}" style="height:${size}px;width:auto;max-width:${size * 3}px;object-fit:contain;display:block;flex:none" loading="lazy">`
  }
  return avatarHtml({ key: opts.key, name: opts.name, size, ...(opts.alt !== undefined ? { alt: opts.alt } : {}) })
}

export function avatarHtml(opts: { key: string | null; name: string; size?: number; alt?: string }): string {
  const size = opts.size ?? 40
  if (opts.key && SWAYQ_SURFACES.avatars) {
    return `<img src="/avatars/${encodeURIComponent(opts.key)}" alt="${escapeHtml(opts.alt ?? opts.name)}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;flex:none" loading="lazy">`
  }
  const initial = opts.name.trim().charAt(0).toUpperCase()
  const layout = `width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--pu-font-mono);font-weight:600;font-size:${Math.round(size * 0.42)}px;flex:none`
  // No name means no initial: a letter from the slug or the email would
  // look like an identity the host never entered. The neutral ring is the
  // open-slot shape — something still to be filled in — not a green badge
  // claiming a name that isn't there.
  if (!initial) {
    return `<div aria-hidden="true" style="${layout};background:var(--pu-paper-dim);color:var(--pu-ink-500);border:2px solid var(--pu-line)">?</div>`
  }
  return `<div aria-hidden="true" style="${layout};background:var(--pu-green-tint);color:var(--pu-green-700)">${escapeHtml(initial)}</div>`
}

/**
 * The company shown for this booking page, or null. A team-owned event's
 * `host` is one representative member picked by `bookingPageContext` for
 * display purposes (see that function's own comment) — real, but not "the"
 * host of a round-robin/collective event. Their company is personal to them,
 * not the team, so it only ever renders for a personal event type, where
 * `host` really is the host. Shared by the header and the page footer so the
 * two can never disagree.
 */
export function displayCompany(d: Pick<BookingPageData, 'host' | 'eventType'>): string | null {
  return d.eventType.ownerTeamId === null ? d.host.company : null
}

/**
 * The muted line under the host's name — "CEO, Acme Inc", either half
 * optional, the company wrapped in a link when the host set one. Returns
 * HTML (everything interpolated is escaped here). Same personal-event-only
 * gate as `displayCompany` — a representative team member's personal
 * title/company would read as the team's. The href was validated to be
 * absolute http(s) at save time (`isHttpUrl` in dashboard-routes.ts), so a
 * stored value can never be a javascript:/data: scheme.
 */
function identityLineHtml(d: Pick<BookingPageData, 'host' | 'eventType'>): string | null {
  if (d.eventType.ownerTeamId !== null) return null
  const companyHtml = d.host.company
    ? d.host.companyUrl
      ? `<a class="pu-host-link" href="${escapeHtml(d.host.companyUrl)}" target="_blank" rel="noopener">${escapeHtml(d.host.company)}</a>`
      : escapeHtml(d.host.company)
    : ''
  const parts = [d.host.jobTitle ? escapeHtml(d.host.jobTitle) : '', companyHtml].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : null
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol" — `conjunction` is "and" or "or". */
export function joinNames(names: string[], conjunction = 'and'): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`
}

/**
 * The sentence naming who the guest will meet, as HTML. Collective promises
 * only the REQUIRED hosts — "You'll meet Alice and Bob" — and says the
 * optional ones "join when free", because that is exactly what an optional
 * host does: a slot is listed whether or not they are free for it, and the
 * confirmation names whoever actually joined. Round-robin names the pool
 * and never a specific person, because the host is picked at commit
 * (ADR-0004 §5: listings are advisory about who). More than four names in
 * a group collapse to three plus a CSS-only "and N more" — no script.
 *
 * Exported on its own because the event-type editor previews it under the
 * Hosts block ("Guests will see"): one function, so the preview and the
 * booking page cannot drift apart. Empty for a personal page or no hosts.
 */
export function hostsSentence(d: Pick<BookingPageData, 'eventType' | 'hosts' | 'team' | 'locale'>): string {
  const hosts = d.hosts ?? []
  if (d.eventType.ownerTeamId === null || hosts.length === 0) return ''
  const collective = d.eventType.schedulingType === 'collective'
  const locale = loc(d)
  const conj = t(locale, collective ? 'hosts.and' : 'hosts.or')
  const promised = collective ? hosts.filter((h) => h.required) : hosts
  const optional = collective ? hosts.filter((h) => !h.required) : []
  const name = (h: ResolvedHost) => h.user.name || h.user.slug

  const group = (list: ResolvedHost[]): string => {
    const names = list.map(name)
    if (names.length <= 4) return `<strong>${escapeHtml(joinNames(names, conj))}</strong>`
    const rest = names.slice(3)
    return (
      `<strong>${escapeHtml(names.slice(0, 3).join(', '))}</strong>` +
      ` <details class="pu-hosts-more"><summary>${escapeHtml(t(locale, 'hosts.more', { n: rest.length }))}</summary><span>${escapeHtml(joinNames(rest, conj))}</span></details>`
    )
  }
  // The team, modestly, in parentheses after the people — unless the team
  // chose not to show its name to guests at all.
  const team = d.team && d.team.showName !== false ? ` <span class="pu-hosts-team">(${escapeHtml(d.team.name)})</span>` : ''
  const lead =
    promised.length > 0
      ? tHtml(locale, collective ? 'hosts.meet' : 'hosts.withOneOf', { names: `${group(promised)}${team}` })
      : ''
  const joins =
    optional.length > 0
      ? `${lead ? '. ' : ''}${tHtml(locale, optional.length === 1 ? 'hosts.joins' : 'hosts.join', {
          names: group(optional),
        })}${lead ? '' : team}`
      : ''
  return `${lead}${joins}`
}

/**
 * Who the guest will meet, for a team-owned page: the avatars and the
 * sentence from `hostsSentence`. Empty for a personal page.
 */
export function hostsRow(d: Pick<BookingPageData, 'eventType' | 'hosts' | 'team' | 'locale'>): string {
  const hosts = d.hosts ?? []
  if (d.eventType.ownerTeamId === null || hosts.length === 0) return ''
  const collective = d.eventType.schedulingType === 'collective'
  const promised = collective ? hosts.filter((h) => h.required) : hosts
  const optional = collective ? hosts.filter((h) => !h.required) : []
  const name = (h: ResolvedHost) => h.user.name || h.user.slug

  // Avatars: the promised hosts first, then optional ones; more than four
  // in total collapses to three and a count.
  const ordered = [...promised, ...optional]
  const shown = ordered.length > 4 ? ordered.slice(0, 3) : ordered
  const stack = shown.map((h) => avatarHtml({ key: h.user.avatarKey, name: name(h), size: 32 })).join('')
  const count = ordered.length > 4 ? `<span class="pu-hosts-count" aria-hidden="true">+${ordered.length - 3}</span>` : ''

  return `<div class="pu-hosts" aria-label="${escapeHtml(t(loc(d), 'hosts.label'))}">
    <div class="pu-hosts-stack">${stack}${count}</div>
    <p class="pu-hosts-text">${hostsSentence(d)}</p>
  </div>`
}

/**
 * The row above the title. A personal page is headed by the host — photo,
 * name, company and title — or by the event type's own logo in place of
 * the photo. A team page is headed by the COMPANY: the instance's logo
 * (the event type's own logo wins), with the brand name beside a round
 * one and nothing beside a wordmark, which already says the name. A team
 * is not a brand, so its name is not up here — it is a suffix after the
 * hosts' names in `hostsRow`, if the team shows it at all. A team page
 * with no logo of either kind has no head row: just the title.
 */
function pageHead(d: BookingPageData): string {
  if (!d.team) {
    const name = d.host.name || d.host.slug
    const identity = identityLineHtml(d)
    return `<div class="pu-host">
    ${logoHtml({ key: d.eventType.logoKey ?? d.host.avatarKey, shape: d.eventType.logoKey ? (d.eventType.logoShape ?? 'circle') : 'circle', name, size: 56 })}
    <div>
      <p class="pu-host-name">${escapeHtml(name)}</p>
      ${identity ? `<p class="pu-host-org">${identity}</p>` : ''}
    </div>
  </div>`
  }
  const key = d.eventType.logoKey ?? d.companyLogo?.key ?? null
  if (!key) return ''
  const shape = d.eventType.logoKey ? (d.eventType.logoShape ?? 'circle') : (d.companyLogo?.shape ?? 'circle')
  const name = d.brandName ?? ''
  return `<div class="pu-host">
    ${logoHtml({ key, shape, name: name || d.eventType.title, size: 56 })}
    ${shape === 'circle' && name ? `<div><p class="pu-host-name">${escapeHtml(name)}</p></div>` : ''}
  </div>`
}

export function eventHeader(d: BookingPageData): string {
  const durationLabel = t(loc(d), 'duration.min', { n: d.eventType.durationMinutes })
  const location = locationLabel(d.eventType, loc(d))
  return `<header class="pu-event-header">
  ${pageHead(d)}
  <h1>${escapeHtml(d.eventType.title)}</h1>
  ${d.eventType.description ? `<p class="pu-muted">${escapeHtml(d.eventType.description)}</p>` : ''}
  <ul class="pu-meta">
    <li><span class="pu-dot"></span> ${escapeHtml(durationLabel)}</li>
    ${location ? `<li>${escapeHtml(location)}</li>` : ''}
    <li>${timezonePicker(d)}</li>
  </ul>
</header>`
}

// Populated once per isolate, not per request — `Intl.supportedValuesOf`
// enumerates the runtime's whole tzdata, which doesn't change between
// requests.
const TIMEZONES: readonly string[] = (() => {
  try {
    // `supportedValuesOf('timeZone')` does not include `UTC` itself in this
    // runtime — without adding it back, a guest already on UTC can see it
    // (their own zone is always prepended, see `timezonePicker`), but no one
    // else can ever pick it.
    const zones = new Set(Intl.supportedValuesOf('timeZone'))
    zones.add('UTC')
    return [...zones].sort()
  } catch {
    return ['UTC']
  }
})()

// Escaping and joining ~400 <option> tags on every single booking-page
// request (month view, day view, confirm — every one renders this picker)
// was slow enough to measurably lengthen the request-rate-limiter smoke
// test's 120-request loop, giving the token bucket real wall-clock time to
// partially refill before the request meant to be denied. None of this
// output depends on the request, so it is built once per isolate; the only
// per-request work is marking one zone `selected`.
const TIMEZONE_OPTIONS_BASE: string = TIMEZONES.map(
  (z) => `<option value="${escapeHtml(z)}">${escapeHtml(z.replace(/_/g, ' '))}</option>`,
).join('')

function timezoneOptionsHtml(selected: string): string {
  if (!TIMEZONES.includes(selected)) {
    // Defensive fallback for a zone the runtime doesn't recognise — prepend
    // it rather than silently dropping the guest's own (mis-detected) zone
    // from the list.
    return (
      `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected.replace(/_/g, ' '))}</option>` +
      TIMEZONE_OPTIONS_BASE
    )
  }
  const marker = `value="${escapeHtml(selected)}">`
  return TIMEZONE_OPTIONS_BASE.replace(marker, `value="${escapeHtml(selected)}" selected>`)
}

/**
 * A real, submitting `<select>` rather than a static label: the guest's
 * detected zone is only a guess (see `resolveGuestTimezone`), and until this
 * existed the only way to correct it was editing `?tz=` in the URL by hand.
 * A GET form degrades to a plain submit button with no JS (`<noscript>`);
 * `onchange` submit is the enhancement, not the only path.
 */
function timezonePicker(d: BookingPageData): string {
  const options = timezoneOptionsHtml(d.guestTimezone)
  // The confirm page has already committed to one slot, which lives only in
  // `start` — its own URL carries no `date`/`month` to fall back to. Posting
  // to the month/day view like every other page would silently drop that
  // slot, so this page's picker instead posts back to `/confirm` itself.
  const action = d.confirmStart !== undefined ? `${bookingPath(d)}/confirm` : bookingPath(d)
  const hiddenFields =
    d.confirmStart !== undefined
      ? `<input type="hidden" name="start" value="${d.confirmStart}">`
      : `${d.selectedDate ? `<input type="hidden" name="date" value="${escapeHtml(d.selectedDate)}">` : ''}
    <input type="hidden" name="month" value="${escapeHtml(d.month)}">`
  // Only numbers interpolated into the style attribute — the zone string
  // itself never is (it's validated upstream, but belt and braces).
  const offset = offsetLabel(Date.now(), d.guestTimezone)
  const zoneCh = d.guestTimezone.length
  const offsetCh = offset.length
  return `<form class="pu-tz-form" method="get" action="${escapeHtml(action)}">
    ${hiddenFields}
    ${d.embed ? '<input type="hidden" name="embed" value="1">' : ''}
    ${d.langExplicit && d.locale ? `<input type="hidden" name="lang" value="${d.locale}">` : ''}
    <label class="pu-sr" for="pu-tz">${escapeHtml(t(loc(d), 'tz.label'))}</label>
    <span class="pu-tz-wrap">
      <svg class="pu-tz-globe" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"
        fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M3.6 9h16.8M3.6 15h16.8M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18"></path>
      </svg>
      <select id="pu-tz" name="tz" class="pu-tz-select" onchange="this.form.submit()"
        style="width:calc(${zoneCh + offsetCh}ch + 4.5rem);padding-right:calc(${offsetCh}ch + 2.2rem)">${options}</select>
      <span class="pu-tz-offset">${escapeHtml(offset)}</span>
    </span>
    <noscript><button type="submit" class="pu-btn pu-btn-ghost" style="padding:.15rem .5rem">${escapeHtml(t(loc(d), 'tz.set'))}</button></noscript>
  </form>`
}

function locationLabel(et: EventType, locale: Locale = 'en'): string {
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

/**
 * The month grid.
 *
 * Rendered as links, not buttons: a day view is a URL, which means the back
 * button works, the page is shareable, and the whole flow degrades to plain
 * HTML with no JavaScript at all.
 */
export function monthGrid(d: BookingPageData): string {
  const [yStr, mStr] = d.month.split('-')
  const year = Number(yStr)
  const month = Number(mStr)
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1))
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const locale = loc(d)
  const leading = (firstOfMonth.getUTCDay() - weekStartsOn(locale) + 7) % 7
  const todayLocal = localDateString(Date.now(), d.host.tz)

  const cells: string[] = []
  for (let i = 0; i < leading; i++) cells.push('<span></span>')

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const has = d.daysWithSlots.get(date) === true
    const current = date === todayLocal ? ' aria-current="date"' : ''
    const selected = date === d.selectedDate ? ' aria-selected="true"' : ''
    if (has) {
      const href =
        `${bookingPath(d)}?date=${date}&tz=${encodeURIComponent(d.guestTimezone)}` +
        (d.embed ? '&embed=1' : '') +
        langQ(d)
      cells.push(
        `<a class="pu-day" data-has-slots="1"${current}${selected} href="${escapeHtml(href)}" ` +
          `aria-label="${escapeHtml(
            t(locale, selected ? 'cal.timesAvailableSelected' : 'cal.timesAvailable', {
              date: humanDate(date, locale),
            }),
          )}">${day}</a>`,
      )
    } else {
      cells.push(`<span class="pu-day" aria-disabled="true"${current}${selected}>${day}</span>`)
    }
  }

  const monthLabel = formatMonthYear(locale, firstOfMonth)

  const prev = shiftMonth(d.month, -1)
  const next = shiftMonth(d.month, 1)
  const base = bookingPath(d)
  const tzq = `&tz=${encodeURIComponent(d.guestTimezone)}${d.embed ? '&embed=1' : ''}${langQ(d)}`

  return `<section class="pu-card" aria-label="${escapeHtml(t(locale, 'cal.chooseDay'))}">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <a class="pu-btn pu-btn-ghost" style="padding:.35rem .6rem"
       href="${escapeHtml(`${base}?month=${prev}${tzq}`)}" aria-label="${escapeHtml(t(locale, 'cal.prevMonth'))}">←</a>
    <h2 style="margin:0">${escapeHtml(monthLabel)}</h2>
    <a class="pu-btn pu-btn-ghost" style="padding:.35rem .6rem"
       href="${escapeHtml(`${base}?month=${next}${tzq}`)}" aria-label="${escapeHtml(t(locale, 'cal.nextMonth'))}">→</a>
  </div>
  <div class="pu-cal" role="grid">
    ${weekdayNames(locale, 'short')
      .map(
        (x, i) =>
          `<div class="pu-cal-head" role="columnheader" aria-label="${escapeHtml(weekdayNames(locale, 'long')[i]!)}">${escapeHtml(x)}</div>`,
      )
      .join('')}
    ${cells.join('\n    ')}
  </div>
</section>`
}

/** Slot list for a chosen day, in the GUEST's timezone. */
export function slotList(d: BookingPageData): string {
  const locale = loc(d)
  const label_ = escapeHtml(t(locale, 'slots.label'))
  if (!d.selectedDate) {
    return `<section class="pu-card" aria-label="${label_}">
      <p class="pu-muted">${escapeHtml(t(locale, 'slots.pickDay'))}</p></section>`
  }
  const slots = d.slots ?? []
  if (slots.length === 0) {
    return `<section class="pu-card" aria-label="${label_}">
      <h2>${escapeHtml(humanDate(d.selectedDate, locale))}</h2>
      <p class="pu-muted">${escapeHtml(t(locale, 'slots.none'))}</p></section>`
  }

  // Every slot the query engine hands back here has already cleared holds,
  // bookings, past times and the host's notice window (src/core/slots/
  // engine.ts never returns those) — so every slot on this page is, by
  // construction, in the 'available' state. slotStateClassName still goes
  // through the shared src/core/slot-state.ts mapping (rather than a literal
  // "pu-slot pu-slot-available" string here) so this call site and the CSS
  // in src/http/styles.ts can never drift from the one place that owns the
  // state → class relationship. The 'held'/'booked'/'past'/
  // 'outside-notice-window' classes it can also produce are exercised today
  // by the semantic-tokens reference page and by test/core/slot-state.test.ts,
  // not by live traffic — showing any of them here would mean the query
  // engine surfacing a status per slot instead of silently omitting it,
  // which is a product decision (does a guest get to see that a time is
  // held/booked at all?) outside this ticket's scope.
  const items = slots
    .map((s) => {
      const label = formatDateTime(locale, s.start, d.guestTimezone, { hour: 'numeric', minute: '2-digit' })
      const href =
        `${bookingPath(d)}/confirm?start=${s.start}` +
        `&tz=${encodeURIComponent(d.guestTimezone)}` +
        (d.embed ? '&embed=1' : '') +
        langQ(d)
      // nofollow: every slot is a distinct URL, and a crawler that follows
      // them enumerates the whole calendar — ten thousand confirm fetches
      // in a fortnight on one event type. Nothing on the far side is worth
      // indexing (it says noindex), so there is nothing to follow.
      return `<a class="${slotStateClassName('available')}" href="${escapeHtml(href)}" rel="nofollow">
        <time datetime="${new Date(s.start).toISOString()}">${escapeHtml(label)}</time></a>`
    })
    .join('\n    ')

  return `<section class="pu-card" aria-label="${label_}">
  <h2>${escapeHtml(humanDate(d.selectedDate, locale))}</h2>
  <p class="pu-muted pu-tz-note">
    ${escapeHtml(t(locale, 'tz.timesShownIn', { tz: tzName(d.guestTimezone), offset: offsetLabel(slots[0]!.start, d.guestTimezone) }))}
  </p>
  <div class="pu-slots">
    ${items}
  </div>
</section>`
}

/** The confirmation form. Includes the hidden hold id when one was placed. */
export function confirmForm(
  d: BookingPageData,
  start: number,
  opts: { holdId?: string; errors?: Record<string, string>; values?: Record<string, string> } = {},
): string {
  const et = d.eventType
  const locale = loc(d)
  const errors = opts.errors ?? {}
  const values = opts.values ?? {}
  const when = formatWhenLong(locale, start, d.guestTimezone)

  const questions = effectiveQuestions(et)
    .map((q) => {
      const err = errors[q.id]
      const val = escapeHtml(values[q.id] ?? '')
      const req = q.required ? ' required aria-required="true"' : ''
      // The built-in agenda question is upstream's English wording; it speaks the guest's language. A host's own questions are shown as the host wrote them.
      const label =
        q.label.trim().toLowerCase() === AGENDA_QUESTION.label.toLowerCase() ? t(locale, 'confirm.agenda') : q.label
      const desc = err ? ` aria-describedby="err-${escapeHtml(q.id)}"` : ''
      const field =
        q.type === 'textarea'
          ? `<textarea id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}"${req}${desc}>${val}</textarea>`
          : q.type === 'select'
            ? `<select id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}"${req}${desc}>
                 <option value=""></option>
                 ${(q.options ?? [])
                   .map(
                     (o) =>
                       `<option value="${escapeHtml(o)}"${values[q.id] === o ? ' selected' : ''}>${escapeHtml(o)}</option>`,
                   )
                   .join('')}
               </select>`
            : `<input id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}" value="${val}"${req}${desc}>`
      return `<label for="q-${escapeHtml(q.id)}">${escapeHtml(label)}${q.required ? '' : ` <span class="pu-muted">${escapeHtml(t(locale, 'confirm.optional'))}</span>`}</label>
        ${field}
        ${err ? `<p class="pu-err" id="err-${escapeHtml(q.id)}">${escapeHtml(err)}</p>` : ''}`
    })
    .join('\n')

  return `<section class="pu-card" aria-label="${escapeHtml(t(locale, 'confirm.title'))}">
  <h2>${escapeHtml(t(locale, 'confirm.title'))}</h2>
  <div class="pu-slot-chosen">
    <span class="pu-dot-lg" aria-hidden="true"></span>
    <span><strong class="pu-time">${escapeHtml(when)}</strong><br>
     <span class="pu-muted">${escapeHtml(
       t(locale, 'confirm.tzLine', {
         tz: `${tzName(d.guestTimezone)} (${offsetLabel(start, d.guestTimezone)})`,
         n: et.durationMinutes,
       }),
     )}</span></span>
  </div>
  <form method="post" action="${escapeHtml(bookingPath(d))}/confirm">
    <input type="hidden" name="start" value="${start}">
    <input type="hidden" name="tz" value="${escapeHtml(d.guestTimezone)}">
    ${d.embed ? '<input type="hidden" name="embed" value="1">' : ''}
    ${d.langExplicit ? `<input type="hidden" name="lang" value="${locale}">` : ''}
    ${opts.holdId ? `<input type="hidden" name="hold" value="${escapeHtml(opts.holdId)}">` : ''}
    <label for="name">${escapeHtml(t(locale, 'confirm.name'))}</label>
    <input id="name" name="name" required aria-required="true" autocomplete="name"
           value="${escapeHtml(values['name'] ?? '')}"
           ${errors['name'] ? 'aria-describedby="err-name"' : ''}>
    ${errors['name'] ? `<p class="pu-err" id="err-name">${escapeHtml(errors['name'])}</p>` : ''}
    <label for="email">${escapeHtml(t(locale, 'confirm.email'))}</label>
    <input id="email" name="email" type="email" required aria-required="true" autocomplete="email"
           value="${escapeHtml(values['email'] ?? '')}"
           ${errors['email'] ? 'aria-describedby="err-email"' : ''}>
    ${errors['email'] ? `<p class="pu-err" id="err-email">${escapeHtml(errors['email'])}</p>` : ''}
    ${questions}
    <label for="colleagues">${escapeHtml(t(locale, 'confirm.colleagues'))} <span class="pu-muted">${escapeHtml(t(locale, 'confirm.optional'))}</span></label>
    <input id="colleagues" name="colleagues" type="text" inputmode="email" autocomplete="off" maxlength="400"
           placeholder="a@example.com, b@example.com"
           value="${escapeHtml(values['x_colleagues'] ?? '')}"
           aria-describedby="hint-colleagues${errors['x_colleagues'] ? ' err-colleagues' : ''}">
    <p class="pu-muted" id="hint-colleagues" style="font-size:.8125rem;margin:.25rem 0 0">${escapeHtml(t(locale, 'confirm.colleaguesHint'))}</p>
    ${errors['x_colleagues'] ? `<p class="pu-err" id="err-colleagues">${escapeHtml(errors['x_colleagues'])}</p>` : ''}
    ${errors['captcha'] ? `<p class="pu-err" role="alert">${escapeHtml(errors['captcha'])}</p>` : ''}
    ${d.turnstileSiteKey ? `<div class="cf-turnstile pu-turnstile" data-sitekey="${escapeHtml(d.turnstileSiteKey)}" data-language="${locale}" data-theme="light"></div>` : ''}
    <p class="pu-muted" style="font-size:.8125rem;margin:1rem 0 0">${escapeHtml(t(locale, 'confirm.inviteNote'))}</p>
    <div style="margin-top:1.25rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="pu-btn" type="submit">${escapeHtml(t(locale, 'confirm.submit'))}</button>
      <a class="pu-btn pu-btn-ghost" href="${escapeHtml(bookingPath(d))}?date=${escapeHtml(localDateString(start, d.guestTimezone))}${d.embed ? '&embed=1' : ''}${langQ(d)}">${escapeHtml(t(locale, 'confirm.back'))}</a>
    </div>
  </form>
</section>`
}

export function bookedConfirmation(opts: {
  eventTitle: string
  hostName: string
  start: number
  guestTimezone: string
  manageUrl: string
  locationLabel?: string
  locale?: Locale
}): string {
  const locale = opts.locale ?? 'en'
  const when = formatWhenLong(locale, opts.start, opts.guestTimezone)
  return `<section class="pu-card pu-confirm" aria-label="${escapeHtml(t(locale, 'booked.region'))}">
  <svg class="pu-confirm-icon" width="56" height="56" viewBox="0 0 96 96" aria-hidden="true">
    <path class="pu-ring-arc" d="M 69.2 30.8 A 30 30 0 1 1 26.8 30.8"
      fill="none" stroke-width="9" stroke-linecap="round"></path>
    <circle class="pu-ring-dot" cx="48" cy="22" r="11"></circle>
  </svg>
  <p><span class="pu-badge">${escapeHtml(t(locale, 'booked.badge'))}</span></p>
  <h1>${escapeHtml(t(locale, 'booked.title'))}</h1>
  <p class="pu-muted">${tHtml(locale, 'booked.with', {
    event: `<strong style="color:var(--pu-ink-950)">${escapeHtml(opts.eventTitle)}</strong>`,
    host: escapeHtml(opts.hostName),
  })}</p>
  <dl class="pu-confirm-details">
    <div><dt>${escapeHtml(t(locale, 'booked.when'))}</dt><dd class="pu-time">${escapeHtml(when)}<br>
      <span class="pu-muted">${escapeHtml(`${tzName(opts.guestTimezone)} (${offsetLabel(opts.start, opts.guestTimezone)})`)}</span></dd></div>
    ${opts.locationLabel ? `<div><dt>${escapeHtml(t(locale, 'booked.where'))}</dt><dd>${escapeHtml(opts.locationLabel)}</dd></div>` : ''}
  </dl>
  <p class="pu-muted">${escapeHtml(t(locale, 'booked.inviteNote'))}</p>
  <p style="margin-top:1.25rem">
    <a class="pu-btn pu-btn-ghost" href="${escapeHtml(opts.manageUrl)}">${escapeHtml(t(locale, 'booked.manage'))}</a>
  </p>
</section>`
}

/**
 * The 409 page.
 *
 * A slot can be listed and then lost: listings may come from a read replica
 * (ADR-0007 §2) and round-robin listings are advisory about who. This is an
 * expected outcome, so it reads as a normal step with the next action right
 * there — not as an error.
 */
export function slotTakenPage(d: BookingPageData, date: string): string {
  const locale = loc(d)
  return `<section class="pu-card" aria-label="${escapeHtml(t(locale, 'taken.title'))}">
  <h1>${escapeHtml(t(locale, 'taken.title'))}</h1>
  <p class="pu-muted">${escapeHtml(t(locale, 'taken.body'))}</p>
  <p style="margin-top:1rem">
    <a class="pu-btn" href="${escapeHtml(bookingPath(d))}?date=${escapeHtml(date)}&tz=${encodeURIComponent(d.guestTimezone)}${d.embed ? '&embed=1' : ''}${langQ(d)}">${escapeHtml(t(locale, 'taken.cta'))}</a>
  </p>
</section>`
}

/**
 * The "temporarily unavailable" state: the host's calendar could not be read,
 * so the page cannot promise real availability. The agent that detects it
 * renders this; the strings live here with the rest of the guest copy.
 */
export function calendarUnavailablePage(locale: Locale = 'en'): string {
  return errorPage(t(locale, 'calendarUnavailable.title'), t(locale, 'calendarUnavailable.body'))
}

/** An IANA id as a person would say it: `America/New_York` -> `America/New York`. */
export function tzName(tz: string): string {
  return tz.replace(/_/g, ' ')
}

export function bookingDriftedPage(locale: Locale = 'en'): string {
  return errorPage(t(locale, 'bookingDrifted.title'), t(locale, 'bookingDrifted.body'))
}

export function errorPage(title: string, message: string): string {
  return `<section class="pu-card">
  <h1>${escapeHtml(title)}</h1>
  <p class="pu-muted">${escapeHtml(message)}</p>
</section>`
}

// ---------------------------------------------------------------------------

export function bookingPath(d: { ownerSlug: string; eventType: EventType }): string {
  return `/${encodeURIComponent(d.ownerSlug)}/${encodeURIComponent(d.eventType.slug)}`
}

function humanDate(date: string, locale: Locale): string {
  return formatLocalDate(locale, date)
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
