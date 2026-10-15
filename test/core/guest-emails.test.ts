/**
 * Guest emails are short notes: what was booked, the time in the guest's
 * zone with the zone named, the invitation line, and the two management links.
 * The calendar invitation itself is Google's, so nothing here claims an
 * attachment.
 */

import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import {
  bookingCancelled,
  bookingConfirmationForGuest,
  bookingConfirmationForHost,
  bookingReminder,
  bookingRescheduled,
} from '../../src/core/email-templates.js'

const host: User = {
  id: 'u_h', email: 'grace@example.com', name: 'Grace Hopper', tz: 'America/New_York', slug: 'grace',
  avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member', createdAt: 0,
}
const eventType = {
  id: 'et', ownerUserId: 'u_h', ownerTeamId: null, schedulingType: 'personal', slug: 'intro', title: 'Intro call',
  description: '', durationMinutes: 30, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  minNoticeMinutes: 0, maxHorizonDays: 60, maxPerDay: null, locationType: 'google_meet', locationValue: null,
  questions: [], active: true, createdAt: 0, scheduleId: null,
} as EventType
const START = Date.UTC(2026, 8, 4, 12, 0)
const booking = {
  id: 'bk', eventTypeId: 'et', hostUserId: 'u_h', hostUserIds: ['u_h'], guestName: 'Anna Jensen',
  guestEmail: 'anna@example.dk', guestTimezone: 'Europe/Copenhagen', startUtc: START, endUtc: START + 30 * 60_000,
  localDate: '2026-09-04', status: 'confirmed', answers: {}, externalEventIds: {}, conferenceUrl: null,
  rescheduleOf: null, rescheduledTo: null, manageTokenHash: 'h', cancelledAt: null, createdAt: 0,
} as Booking

const ctx = (locale: 'en' | 'da') => ({
  booking,
  eventType,
  host,
  brandName: 'SwayQ',
  locale,
  rescheduleUrl: 'https://book.test/booking/bk?token=T',
  cancelUrl: 'https://book.test/booking/bk?token=T',
})

const EM_DASH = String.fromCharCode(0x2014)

describe('guest confirmation', () => {
  it('Danish: names the booking, the time in the guest zone WITH its name, the invitation line and both links', () => {
    const mail = bookingConfirmationForGuest(ctx('da'))
    expect(mail.subject).toContain('Bekræftet: Intro call med Grace Hopper')
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('Intro call')
      expect(body).toContain('Grace Hopper')
      expect(body).toContain('Europe/Copenhagen, GMT+2')
      expect(body).toContain('Du modtager en kalenderinvitation fra Google.')
      expect(body).toContain('https://book.test/booking/bk?token=T')
    }
    expect(mail.text).toContain('Flyt mødet')
    expect(mail.text).toContain('Aflys')
    expect(mail.html).toContain('<html lang="da">')
    // 14:00 in Copenhagen, Danish date.
    expect(mail.text).toMatch(/fredag/i)
    expect(mail.text).toMatch(/14[.:]00/)
  })

  it('English: same facts, English words', () => {
    const mail = bookingConfirmationForGuest(ctx('en'))
    expect(mail.subject).toContain('Confirmed: Intro call with Grace Hopper')
    expect(mail.text).toContain('You will receive a calendar invitation from Google.')
    expect(mail.text).toContain('Reschedule: https://book.test/booking/bk?token=T')
    expect(mail.text).toContain('Cancel: https://book.test/booking/bk?token=T')
  })

  it('does not claim an attachment or hand out an .ics of its own', () => {
    for (const locale of ['en', 'da'] as const) {
      const mail = bookingConfirmationForGuest({ ...ctx(locale), hasAttachment: true })
      expect(mail.text).not.toMatch(/attach|vedhæft|\.ics/i)
      expect(mail.html).not.toMatch(/attach|vedhæft|\.ics/i)
    }
  })

  it('replies go to the host', () => {
    expect(bookingConfirmationForGuest(ctx('en')).replyTo).toBe('grace@example.com')
    expect(bookingConfirmationForGuest(ctx('da')).text).toContain('Svar på denne mail for at skrive til Grace Hopper')
  })

  it('is the SwayQ palette and wordmark: lime button with carbon text, period the same colour', () => {
    const html = bookingConfirmationForGuest(ctx('en')).html
    expect(html).toContain('bgcolor="#DBED72"')
    expect(html).toMatch(/color:#0E0E0E;text-decoration:none;border-radius:10px;">Reschedule</)
    expect(html).toContain('swayq<span>.</span>')
    expect(html).not.toContain('punctual:')
  })

  it('escapes what a guest typed', () => {
    const mail = bookingConfirmationForGuest({ ...ctx('en'), booking: { ...booking, guestName: '<img src=x>' } })
    expect(mail.html).not.toContain('<img src=x>')
  })
})

describe('guest reschedule, cancellation, reminder', () => {
  it('rescheduled: both times, the old one struck, links, and the old-links warning in Danish', () => {
    const mail = bookingRescheduled({
      ...ctx('da'),
      audience: 'guest',
      previous: { startUtc: START - 86_400_000, endUtc: START - 86_400_000 + 1_800_000 },
    })
    expect(mail.subject.startsWith('Flyttet:')).toBe(true)
    expect(mail.text).toContain('Tidligere')
    expect(mail.text).toContain('virker ikke længere')
    expect(mail.text).toContain('https://book.test/booking/bk?token=T')
    expect(mail.html).toContain('line-through')
    expect(mail.replyTo).toBe('grace@example.com')
  })

  it('cancelled: says who, offers a rebook link, no management links to a dead booking', () => {
    const mail = bookingCancelled({
      ...ctx('da'),
      rescheduleUrl: undefined,
      cancelUrl: undefined,
      audience: 'guest',
      cancelledBy: 'host',
      reason: 'Jeg er syg',
      rebookUrl: 'https://book.test/grace/intro',
    })
    expect(mail.text).toContain('Grace Hopper har aflyst Intro call og skrev: “Jeg er syg”')
    expect(mail.text).toContain('Book et nyt tidspunkt: https://book.test/grace/intro')
    expect(mail.html).toContain('#A32116')
  })

  it('reminders are localized too', () => {
    const mail = bookingReminder({ ...ctx('da'), audience: 'guest', when: '24h' })
    expect(mail.subject.startsWith('I morgen:')).toBe(true)
    expect(mail.text).toContain('Dit møde er i morgen')
  })

  it('no em dash in any guest mail, in either language', () => {
    for (const locale of ['en', 'da'] as const) {
      const mails = [
        bookingConfirmationForGuest(ctx(locale)),
        bookingRescheduled({ ...ctx(locale), audience: 'guest', previous: { startUtc: START - 1e8, endUtc: START - 1e8 + 1e6 } }),
        bookingCancelled({ ...ctx(locale), audience: 'guest', cancelledBy: 'guest', rebookUrl: 'https://book.test/x' }),
        bookingReminder({ ...ctx(locale), audience: 'guest', when: '1h' }),
      ]
      for (const m of mails) {
        expect(m.subject.includes(EM_DASH)).toBe(false)
        expect(m.text.includes(EM_DASH)).toBe(false)
      }
    }
  })
})

describe('host notification', () => {
  it('says so when the same guest already has a booking with the host', () => {
    const prior = Date.UTC(2026, 8, 10, 12, 0)
    const mail = bookingConfirmationForHost({ ...ctx('en'), bookingUrl: 'https://book.test/dashboard/bookings/bk', priorBookingStartUtc: prior })
    expect(mail.text).toContain('This guest already has a booking with you on')
    expect(mail.text).toContain('September 10, 2026')
    expect(bookingConfirmationForHost(ctx('en')).text).not.toContain('already has a booking')
  })

  it('host mail stays English whatever the guest speaks', () => {
    const mail = bookingConfirmationForHost(ctx('da'))
    expect(mail.subject).toContain('New booking')
  })
})
