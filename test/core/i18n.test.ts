import { describe, expect, it } from 'vitest'
import { da } from '../../src/core/i18n/da.js'
import { en } from '../../src/core/i18n/en.js'
import {
  formatLocalDate,
  formatWhenLong,
  langCookieHeader,
  localeFromRequest,
  parseAcceptLanguage,
  resolveLocale,
  t,
  tHtml,
  weekdayNames,
  weekStartsOn,
} from '../../src/core/i18n/index.js'

const EM_DASH = String.fromCharCode(0x2014)
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

describe('dictionaries', () => {
  const enKeys = Object.keys(en).sort()
  const daKeys = Object.keys(da).sort()

  it('every English key exists in Danish, and Danish has nothing extra', () => {
    const missing = enKeys.filter((k) => !(k in da))
    const extra = daKeys.filter((k) => !(k in en))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it('no string is empty', () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(da)]) expect(v.trim(), k).not.toBe('')
  })

  it('both languages use the same placeholders for each key', () => {
    for (const k of enKeys) {
      expect(placeholders((da as Record<string, string>)[k]!), k).toEqual(placeholders((en as Record<string, string>)[k]!))
    }
  })

  it('no em dash in any guest-facing string', () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(da)]) expect(v.includes(EM_DASH), k).toBe(false)
  })

  it('never translates the word "creator" if it appears', () => {
    for (const v of Object.values(da)) expect(v).not.toMatch(/skaber|kreatør/i)
  })

  it('a Danish string is not just the English one (a copied key is an untranslated key)', () => {
    // These are the same in both languages on purpose: product names and the EN/DA toggle.
    const same = new Set(['lang.en', 'lang.da', 'lang.enName', 'lang.daName', 'loc.meet', 'loc.online'])
    for (const k of enKeys) {
      if (same.has(k)) continue
      expect((da as Record<string, string>)[k], k).not.toBe((en as Record<string, string>)[k])
    }
  })
})

describe('t and tHtml', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('en', 'duration.min', { n: 30 })).toBe('30 min')
    expect(t('da', 'duration.min', { n: 30 })).toBe('30 min.')
    expect(t('en', 'email.confirmed.intro', { guest: 'Ann' })).toContain('{host}')
  })

  it('tHtml escapes the dictionary text but trusts the variables the caller built', () => {
    expect(tHtml('en', 'hosts.meet', { names: '<strong>A &amp; B</strong>' })).toBe("You'll meet <strong>A &amp; B</strong>")
  })
})

describe('locale precedence', () => {
  it('?lang= beats cookie beats stored beats Accept-Language beats English', () => {
    const all = { query: 'en', cookie: 'x=1; pu_lang=da', stored: 'da', acceptLanguage: 'da' }
    expect(resolveLocale(all)).toEqual({ locale: 'en', explicit: true })
    expect(resolveLocale({ ...all, query: null })).toEqual({ locale: 'da', explicit: false })
    expect(resolveLocale({ cookie: 'pu_lang=en', stored: 'da', acceptLanguage: 'da' }).locale).toBe('en')
    expect(resolveLocale({ stored: 'da', acceptLanguage: 'en' }).locale).toBe('da')
    expect(resolveLocale({ acceptLanguage: 'da-DK,da;q=0.9' }).locale).toBe('da')
    expect(resolveLocale({}).locale).toBe('en')
  })

  it('ignores an unsupported ?lang=, cookie or stored value instead of trusting it', () => {
    expect(resolveLocale({ query: 'fr', cookie: 'pu_lang=de', stored: 'sv', acceptLanguage: 'da' })).toEqual({
      locale: 'da',
      explicit: false,
    })
  })

  it('honours q-values in Accept-Language and skips languages it does not speak', () => {
    expect(parseAcceptLanguage('en;q=0.4, da;q=0.8')).toBe('da')
    expect(parseAcceptLanguage('de, fr;q=0.9, da;q=0.1')).toBe('da')
    expect(parseAcceptLanguage('da;q=0, en')).toBe('en')
    expect(parseAcceptLanguage('de, fr')).toBeUndefined()
    expect(parseAcceptLanguage(null)).toBeUndefined()
  })

  it('reads a Request', () => {
    const req = new Request('https://x.test/p?lang=da', { headers: { cookie: 'pu_lang=en', 'accept-language': 'en' } })
    expect(localeFromRequest(req)).toEqual({ locale: 'da', explicit: true })
  })

  it('the cookie is a Lax preference that lasts a year', () => {
    expect(langCookieHeader('da', true)).toBe('pu_lang=da; Path=/; Max-Age=31536000; SameSite=Lax; Secure')
    expect(langCookieHeader('en', false)).not.toContain('Secure')
  })
})

describe('Danish dates', () => {
  // 2026-09-04 is a Friday.
  const NOON_UTC = Date.UTC(2026, 8, 4, 12, 0)

  it('formats weekday, month and time in Danish, in the guest zone', () => {
    const da_ = formatWhenLong('da', NOON_UTC, 'Europe/Copenhagen')
    expect(da_).toMatch(/fredag/i)
    expect(da_).toContain('september')
    expect(da_).toMatch(/\b14[.:]00\b/) // 14:00 in Copenhagen (CEST), 24-hour clock
    const en_ = formatWhenLong('en', NOON_UTC, 'Europe/Copenhagen')
    expect(en_).toContain('Friday')
    expect(en_).toContain('2:00')
  })

  it('formats a zone-free date in the locale', () => {
    expect(formatLocalDate('da', '2026-09-04')).toMatch(/fredag/i)
    expect(formatLocalDate('en', '2026-09-04')).toBe('Friday, September 4')
  })

  it('Danish weeks start on Monday, English on Sunday', () => {
    expect(weekStartsOn('da')).toBe(1)
    expect(weekStartsOn('en')).toBe(0)
    expect(weekdayNames('en', 'short')[0]).toBe('Sun')
    expect(weekdayNames('da', 'long')[0]).toMatch(/mandag/i)
    expect(weekdayNames('da', 'long')[6]).toMatch(/søndag/i)
  })
})
