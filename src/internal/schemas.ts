/**
 * Zod schemas for every internal RPC method. Parsed AFTER the service token
 * check, so an unauthenticated caller learns nothing about the input shape.
 */

import { z } from 'zod'
import { isValidTimeZone } from '../core/time/zone.js'

/** Trim + lowercase. Applied before every comparison and lookup. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

const email = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .pipe(z.email({ message: 'not a valid email address' }))

const instant = z.iso
  .datetime({ offset: true, message: 'must be ISO 8601 with a timezone offset' })
  .transform((s) => Date.parse(s))

const timezone = z.string().max(64).refine(isValidTimeZone, { message: 'not a valid IANA timezone' })

/** Attendee lists are capped well above MAX_ATTENDEES so the cap is a typed error, not a schema one. */
const attendees = z.array(z.string().max(254)).max(200)

const base = {
  token: z.string(),
  actingUserEmail: email,
}

export const findTimeSchema = z
  .object({
    ...base,
    attendeeEmails: attendees,
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(480)
      .refine((n) => n % 5 === 0, { message: 'must be a multiple of 5' }),
    windowStart: instant,
    windowEnd: instant,
    timezone,
    workingHoursOnly: z.boolean().optional(),
  })
  .refine((v) => v.windowEnd > v.windowStart, { message: 'windowEnd must be after windowStart', path: ['windowEnd'] })
  .refine((v) => v.windowEnd - v.windowStart <= 31 * 86_400_000, {
    message: 'window may span at most 31 days',
    path: ['windowEnd'],
  })

export const createMeetingSchema = z
  .object({
    ...base,
    attendeeEmails: attendees,
    start: instant,
    end: instant,
    timezone,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(8000).optional(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .refine((v) => v.end > v.start, { message: 'end must be after start', path: ['end'] })
  .refine((v) => v.end - v.start <= 8 * 3_600_000, { message: 'a meeting may last at most 8 hours', path: ['end'] })

export const listMyMeetingsSchema = z
  .object({ ...base, from: instant, to: instant })
  .refine((v) => v.to > v.from, { message: 'to must be after from', path: ['to'] })
  .refine((v) => v.to - v.from <= 92 * 86_400_000, { message: 'range may span at most 92 days', path: ['to'] })

/** Google event ids are base32hex, 5..1024 chars; anything else cannot be ours. */
const eventId = z.string().regex(/^[a-v0-9_]{5,1024}$/, { message: 'not a valid event id' })

export const rescheduleMeetingSchema = z
  .object({ ...base, eventId, start: instant, end: instant, timezone: timezone.optional() })
  .refine((v) => v.end > v.start, { message: 'end must be after start', path: ['end'] })
  .refine((v) => v.end - v.start <= 8 * 3_600_000, { message: 'a meeting may last at most 8 hours', path: ['end'] })

export const cancelMeetingSchema = z.object({ ...base, eventId })

export const myBookingLinksSchema = z.object(base)
