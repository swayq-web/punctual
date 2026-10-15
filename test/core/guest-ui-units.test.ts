/**
 * Pure units behind the guest surface: Turnstile policy, the guest-email
 * helpers, surface switches, and the SwayQ palette's contrast.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  GUEST_EMAIL_DAILY_LIMIT,
  countRecentGuestBookings,
  findOtherUpcomingGuestBooking,
  normalizeGuestEmail,
} from '../../src/core/domain/guest-history.js'
import type { Booking } from '../../src/core/domain/types.js'
import { SWAYQ_SURFACES, blockedByForm, blockedSurface, type SurfaceFlags } from '../../src/swayq-surfaces.js'
import { SWAYQ_INK, SWAYQ_LIME, SWAYQ_PAGE, SWAYQ_SKIN_CSS, guestPageCss } from '../../src/http/swayq-skin.js'
import { decideTurnstile, turnstileConfig, verifyTurnstile } from '../../src/http/turnstile.js'
import { shellFoot, shellHead, wordmarkHtml } from '../../src/http/pages/booking.js'

describe('Turnstile policy', () => {
  it('reads the three settings; blank is unset; only "1" or "true" is required', () => {
    expect(turnstileConfig({})).toEqual({ siteKey: undefined, secret: undefined, required: false })
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: ' k ', TURNSTILE_SECRET: '', TURNSTILE_REQUIRED: 'TRUE' })).toEqual({
      siteKey: 'k',
      secret: undefined,
      required: true,
    })
    expect(turnstileConfig({ TURNSTILE_REQUIRED: '0' }).required).toBe(false)
    expect(turnstileConfig(undefined).required).toBe(false)
  })

  it('verify with a secret, refuse when required without one, skip only otherwise', () => {
    expect(decideTurnstile({ siteKey: undefined, secret: 's', required: false })).toBe('verify')
    expect(decideTurnstile({ siteKey: undefined, secret: 's', required: true })).toBe('verify')
    expect(decideTurnstile({ siteKey: undefined, secret: undefined, required: true })).toBe('refuse')
    expect(decideTurnstile({ siteKey: undefined, secret: undefined, required: false })).toBe('skip')
  })

  it('refuses an empty or oversized token without calling siteverify', async () => {
    const f = vi.fn()
    const cfg = { siteKey: 'k', secret: 's', required: true }
    expect(await verifyTurnstile(cfg, '', undefined, f as never)).toEqual({ ok: false, reason: 'missing_token' })
    expect(await verifyTurnstile(cfg, 'x'.repeat(3000), undefined, f as never)).toEqual({ ok: false, reason: 'missing_token' })
    expect(f).not.toHaveBeenCalled()
  })

  it('a non-200 from siteverify is a refusal, not a pass', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 }))
    const res = await verifyTurnstile({ siteKey: 'k', secret: 's', required: true }, 'tok', undefined, f as never)
    expect(res).toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('guest email helpers', () => {
  const booking = (patch: Partial<Booking>): Booking =>
    ({ id: 'b', guestEmail: 'a@x.dk', status: 'confirmed', startUtc: 2_000, ...patch }) as Booking

  it('the limit is three; case, space and a +tag never buy a second identity', () => {
    expect(GUEST_EMAIL_DAILY_LIMIT).toBe(3)
    expect(normalizeGuestEmail('  Anna@X.dk ')).toBe('anna@x.dk')
    expect(normalizeGuestEmail('anna+2@x.dk')).toBe('anna@x.dk')
    expect(normalizeGuestEmail('a+b+c@x.dk')).toBe('a@x.dk')
    expect(normalizeGuestEmail('+tag@x.dk')).toBe('+tag@x.dk') // nothing before the plus: left alone
    expect(normalizeGuestEmail('nope')).toBe('nope')
  })

  it('counts only confirmed bookings this guest made in the last day, once each', () => {
    const now = 10 * 86_400_000
    const mk = (id: string, patch: Partial<Booking>) => booking({ id, createdAt: now - 1_000, ...patch })
    const list = [
      mk('a', {}),
      mk('a', {}), // the same booking listed twice (collective hosts)
      mk('b', { guestEmail: 'A+x@X.DK' }),
      mk('old', { createdAt: now - 25 * 3_600_000 }),
      mk('cancelled', { status: 'cancelled' }),
      mk('moved', { rescheduleOf: 'a' }),
      mk('other', { guestEmail: 'z@x.dk' }),
    ]
    expect(countRecentGuestBookings(list, 'a@x.dk', now)).toBe(2)
  })

  it('finds the earliest OTHER upcoming confirmed booking of the same guest', () => {
    const current = booking({ id: 'now', startUtc: 5_000 })
    const others = [
      current,
      booking({ id: 'old', startUtc: 500 }), // past
      booking({ id: 'cancelled', status: 'cancelled', startUtc: 3_000 }),
      booking({ id: 'someone-else', guestEmail: 'b@x.dk', startUtc: 2_500 }),
      booking({ id: 'later', guestEmail: 'A@X.DK', startUtc: 9_000 }),
      booking({ id: 'sooner', startUtc: 4_000 }),
    ]
    expect(findOtherUpcomingGuestBooking(others, current, 1_000)).toBe(4_000)
    expect(findOtherUpcomingGuestBooking([current], current, 1_000)).toBeNull()
  })
})

describe('surface switches', () => {
  it('SwayQ ships every listed surface off', () => {
    expect(Object.values(SWAYQ_SURFACES).every((v) => v === false)).toBe(true)
  })

  it('maps paths to the surface they belong to, and turning a flag on lifts the gate', () => {
    expect(blockedSurface('/avatars/abc')).toBe('avatars')
    expect(blockedSurface('/dashboard/settings/avatar/delete')).toBe('avatars')
    expect(blockedSurface('/dashboard/event-types/et_1/logo-shape')).toBe('avatars')
    expect(blockedSurface('/dashboard/admin/logo/delete')).toBe('avatars')
    expect(blockedSurface('/dashboard/insights')).toBe('insights')
    expect(blockedSurface('/auth/microsoft/start')).toBe('microsoft')
    expect(blockedSurface('/dashboard/api-keys/k1/revoke')).toBe('apiKeys')
    // Neighbours are not caught by a prefix accident.
    expect(blockedSurface('/dashboard/settings')).toBeNull()
    expect(blockedSurface('/auth/google/start')).toBeNull()
    expect(blockedSurface('/dashboard/event-types/et_1')).toBeNull()
    expect(blockedSurface('/avatarsx/foo')).toBeNull()
    const on: SurfaceFlags = { ...SWAYQ_SURFACES, insights: true }
    expect(blockedSurface('/dashboard/insights', on)).toBeNull()
  })

  it('a Telegram channel is blocked by form, a Slack one is not', () => {
    const form = (kind: string) => ({ get: (n: string) => (n === 'kind' ? kind : null) })
    expect(blockedByForm('/dashboard/notifications', form('telegram'))).toBe('telegram')
    expect(blockedByForm('/dashboard/teams/t1/notifications', form('telegram'))).toBe('telegram')
    expect(blockedByForm('/dashboard/notifications', form('slack'))).toBeNull()
    expect(blockedByForm('/dashboard/settings', form('telegram'))).toBeNull()
  })
})

// WCAG relative luminance and contrast ratio.
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('SwayQ skin', () => {
  it('uses the swayq-2026 lime, carbon and sand', () => {
    expect(SWAYQ_LIME).toBe('#dbed72')
    expect(SWAYQ_INK).toBe('#0e0e0e')
    expect(SWAYQ_PAGE).toBe('#f8f7f5')
  })

  it('lime needs dark text: every lime fill carries carbon ink, at AA', () => {
    expect(contrast(SWAYQ_INK, SWAYQ_LIME)).toBeGreaterThanOrEqual(7)
    // The 1.2:1 lime-on-page reading is why lime is never ink.
    expect(contrast(SWAYQ_LIME, SWAYQ_PAGE)).toBeLessThan(1.5)
    expect(SWAYQ_SKIN_CSS).toMatch(/\.pu-btn\{color:#0e0e0e/)
  })

  it('body, muted text and the danger button all clear AA on their grounds', () => {
    expect(contrast('#0e0e0e', '#f8f7f5')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#4a4a4a', '#f8f7f5')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#4a4a4a', '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', '#a32116')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#a32116', '#f8f7f5')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#f8f7f5', '#0e0e0e')).toBeGreaterThanOrEqual(4.5) // the active language chip
  })

  it('beats upstream dark mode (guest pages are light only) and loads only same-origin fonts', () => {
    const css = guestPageCss()
    expect(css.indexOf(':root:root:root')).toBeGreaterThan(css.indexOf('prefers-color-scheme:dark'))
    expect(css).toContain('color-scheme:light')
    expect(css).not.toMatch(/url\(https?:/)
    expect(css).toContain('/fonts/poppins-600.woff2')
  })

  it('the wordmark is lowercase and the period carries no colour of its own', () => {
    expect(wordmarkHtml('SwayQ')).toBe('<span class="pu-mark" aria-label="SwayQ">swayq<span>.</span></span>')
    expect(SWAYQ_SKIN_CSS).toContain('.pu-mark span{color:inherit}')
    expect(SWAYQ_SKIN_CSS).not.toMatch(/\.pu-mark span\{[^}]*#dbed72/)
  })

  it('a guest page head: lang attribute, light colour scheme, no robots meta only when indexable', () => {
    const head = shellHead({ title: 't', brandName: 'SwayQ', guest: true, locale: 'da', canonical: 'https://x.test/a' })
    expect(head).toContain('<html lang="da">')
    expect(head).toContain('<meta name="color-scheme" content="light">')
    expect(head).toContain('rel="canonical"')
    expect(head).not.toContain('noindex')
    const sensitive = shellHead({ title: 't', brandName: 'SwayQ', guest: true, sensitive: true, canonical: 'https://x.test/a' })
    expect(sensitive).toContain('<meta name="robots" content="noindex">')
    expect(sensitive).toContain('<meta name="referrer" content="no-referrer">')
    expect(sensitive).not.toContain('rel="canonical"')
  })

  it('the guest footer is the wordmark, not a link out', () => {
    const foot = shellFoot(true, false, null, { locale: 'da', brandName: 'SwayQ' })
    expect(foot).toContain('Booking via')
    expect(foot).toContain('swayq<span>.</span>')
    expect(foot).not.toContain('href="http')
  })
})
