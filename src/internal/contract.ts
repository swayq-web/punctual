/**
 * The internal scheduling RPC contract (docs/internal-api.md).
 *
 * The SwayQ app Worker calls these through a Cloudflare service binding to the
 * `InternalApi` entrypoint, acting as one staff member. Every result is a
 * typed union: the RPC boundary never carries a thrown provider error, a
 * token, a raw provider body, or another user's event contents.
 */

export type InternalErrorCode =
  /** The deployment has no INTERNAL_SERVICE_TOKEN: every call is refused. */
  | 'SERVICE_NOT_CONFIGURED'
  /** Missing or wrong service token. */
  | 'UNAUTHORIZED'
  /** Input failed validation; `issues` names the fields. */
  | 'INVALID_INPUT'
  /** `actingUserEmail` is not an active Punctual user (or is outside the allowed domains). */
  | 'UNKNOWN_ACTOR'
  /** At least one attendee is not an active Punctual user. The whole request was refused; nothing was sent. */
  | 'EXTERNAL_ATTENDEE'
  /** More than MAX_ATTENDEES distinct attendees. */
  | 'TOO_MANY_ATTENDEES'
  /** A participant's calendar could not be read (or none is connected). Fails closed. */
  | 'CALENDAR_UNAVAILABLE'
  /** The acting user has no Google connection with a write calendar. */
  | 'NO_WRITE_CALENDAR'
  /** The acting user's write calendar is not Google (internal meetings are Google-only). */
  | 'UNSUPPORTED_PROVIDER'
  /** A participant is busy in the requested slot; `busyEmails` names who. */
  | 'SLOT_BUSY'
  /** No such event on the acting user's write calendar. */
  | 'NOT_FOUND'
  /** The event is not an internal meeting organized by the acting user. */
  | 'NOT_OWNER'
  /** The idempotency key was already used for a different (or cancelled) meeting. */
  | 'IDEMPOTENCY_CONFLICT'
  /** Google refused or failed the write. No details cross the boundary. */
  | 'PROVIDER_ERROR'
  /** Anything else. Logged server-side without secrets. */
  | 'INTERNAL_ERROR'

export interface InternalError {
  ok: false
  code: InternalErrorCode
  message: string
  /** EXTERNAL_ATTENDEE: the offending addresses (normalized). */
  externalEmails?: string[]
  /** CALENDAR_UNAVAILABLE: whose calendar could not be read. Email only. */
  unavailableEmails?: string[]
  /** SLOT_BUSY: who is busy. */
  busyEmails?: string[]
  /** INVALID_INPUT: field paths and messages. */
  issues?: Array<{ path: string; message: string }>
}

export type InternalResult<T> = ({ ok: true } & T) | InternalError

export const MAX_ATTENDEES = 20
export const MAX_SLOTS = 10

// --- inputs ---------------------------------------------------------------

interface Authed {
  /** The shared INTERNAL_SERVICE_TOKEN. */
  token: string
  actingUserEmail: string
}

export interface FindTimeInput extends Authed {
  /** Other participants. The acting user is always included. */
  attendeeEmails: string[]
  /** Multiple of 5, 5..480. */
  durationMinutes: number
  /** ISO 8601 with offset. */
  windowStart: string
  windowEnd: string
  /** IANA zone the labels are rendered in. */
  timezone: string
  /** Default true: respect each participant's Punctual default schedule. */
  workingHoursOnly?: boolean
}

export interface CreateMeetingInput extends Authed {
  attendeeEmails: string[]
  start: string
  end: string
  timezone: string
  title: string
  description?: string
  /** Caller-chosen; a retry with the same key returns the same event. */
  idempotencyKey: string
}

export interface ListMyMeetingsInput extends Authed {
  from: string
  to: string
}

export interface RescheduleMeetingInput extends Authed {
  eventId: string
  start: string
  end: string
  /** Optional; defaults to the acting user's Punctual timezone. */
  timezone?: string
}

export interface CancelMeetingInput extends Authed {
  eventId: string
}

export type MyBookingLinksInput = Authed

// --- outputs --------------------------------------------------------------

export interface BusyBlock {
  start: string
  end: string
}

export interface CandidateSlot {
  start: string
  end: string
  /** e.g. "Tue, Oct 20, 10:00 AM" in the requested timezone. */
  label: string
}

export interface FindTimeOutput {
  timezone: string
  slots: CandidateSlot[]
  /** Busy blocks only: never titles, descriptions or attendees. */
  busy: Array<{ email: string; blocks: BusyBlock[] }>
}

export interface MeetingOutput {
  eventId: string
  htmlLink: string | null
  meetUrl: string | null
  start: string
  end: string
  timezone: string
  attendees: string[]
}

export interface CreateMeetingOutput extends MeetingOutput {
  /** false when an earlier call with the same idempotency key already created it. */
  created: boolean
}

export interface ListedMeeting {
  eventId: string
  title: string
  start: string
  end: string
  htmlLink: string | null
  meetUrl: string | null
  attendees: Array<{ email: string; responseStatus: string | null }>
}

export interface ListMyMeetingsOutput {
  meetings: ListedMeeting[]
}

export interface CancelMeetingOutput {
  eventId: string
  /** false when the event was already gone. */
  cancelled: boolean
}

export interface BookingLink {
  title: string
  slug: string
  durationMinutes: number
  url: string
}

export interface MyBookingLinksOutput {
  links: BookingLink[]
}
