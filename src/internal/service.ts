/**
 * Internal scheduling for SwayQ staff (SWA-1289): find a time, send the
 * invite, list / move / cancel what you organized, and share your booking
 * links. Reached only through the `InternalApi` WorkerEntrypoint
 * (./entrypoint.ts) over a Cloudflare service binding.
 *
 * The invariants, in the order every method enforces them:
 *
 *  1. Service token (constant time; an unset secret refuses everything).
 *  2. Input validated with zod.
 *  3. The acting user is an existing Punctual user (Punctual has no
 *     disabled flag: removing a user from the instance IS deactivation),
 *     optionally restricted to INTERNAL_ALLOWED_DOMAINS.
 *  4. EVERY attendee is such a user too. One outsider refuses the WHOLE
 *     request with EXTERNAL_ATTENDEE; nothing is sent to anyone.
 *  5. Busy time is read FRESH (no KV cache) from every participant's read
 *     connections, and any read failure fails closed (CALENDAR_UNAVAILABLE).
 *  6. Reschedule and cancel touch only an event on the acting user's own
 *     write calendar that carries the private internal marker AND names the
 *     acting user as `swayqOrganizer`.
 *
 * Pure of Cloudflare imports, so it runs in the `core` Vitest project with
 * fake ports and a scripted Google.
 */

import type { z } from 'zod'
import type { CalendarConnection, EventType, Interval, User, WeeklySchedule } from '../core/domain/types.js'
import type { EnginePorts, Repositories } from '../ports.js'
import { combineBusy, partitionConnections } from '../core/domain/booking-service.js'
import { computeSlots, type HostAvailabilityInput } from '../core/slots/engine.js'
import { mergeIntervals, overlapsAny, subtractIntervals } from '../core/slots/intervals.js'
import { formatInZone, localDateString } from '../core/time/zone.js'
import { stableEventIds } from '../adapters/calendar-ids.js'
import { CalendarApiError, type CalendarProviderDeps, needsReconnect, needsSetup } from '../adapters/oauth.js'
import {
  deleteInternalEvent,
  getInternalEvent,
  insertInternalEvent,
  type InternalGoogleEvent,
  listInternalEvents,
  patchInternalEventTime,
  resolveInternalMeetUrl,
} from '../adapters/google/internal-meetings.js'
import {
  type CancelMeetingOutput,
  type CreateMeetingOutput,
  type FindTimeOutput,
  type InternalError,
  type InternalErrorCode,
  type InternalResult,
  type ListMyMeetingsOutput,
  MAX_ATTENDEES,
  MAX_SLOTS,
  type MeetingOutput,
  type MyBookingLinksOutput,
} from './contract.js'
import {
  cancelMeetingSchema,
  createMeetingSchema,
  findTimeSchema,
  listMyMeetingsSchema,
  myBookingLinksSchema,
  normalizeEmail,
  rescheduleMeetingSchema,
} from './schemas.js'
import { verifyServiceToken } from './token.js'

export interface InternalServiceDeps {
  ports: Pick<EnginePorts, 'repositories' | 'calendars' | 'clock' | 'config'>
  /** For the Google event calls (insert/get/list/patch/delete). */
  providerDeps: CalendarProviderDeps
  /** INTERNAL_SERVICE_TOKEN. Unset or blank refuses every call. */
  serviceToken: string | undefined
  /** Optional second gate on actor and attendees: lowercase domains, e.g. ["swayq.com"]. Empty = no domain gate. */
  allowedDomains?: string[]
  /** Error sink. Receives the method and error NAME only, never messages or bodies. */
  logError?: (method: string, errorName: string) => void
}

export interface InternalService {
  findTime(raw: unknown): Promise<InternalResult<FindTimeOutput>>
  createMeeting(raw: unknown): Promise<InternalResult<CreateMeetingOutput>>
  listMyMeetings(raw: unknown): Promise<InternalResult<ListMyMeetingsOutput>>
  rescheduleMeeting(raw: unknown): Promise<InternalResult<MeetingOutput>>
  cancelMeeting(raw: unknown): Promise<InternalResult<CancelMeetingOutput>>
  myBookingLinks(raw: unknown): Promise<InternalResult<MyBookingLinksOutput>>
}

/** Thrown inside a handler to return a typed error; never crosses the boundary as a throw. */
class Refusal extends Error {
  constructor(readonly error: InternalError) {
    super(error.code)
    this.name = 'Refusal'
  }
}

function refuse(code: InternalErrorCode, message: string, extra: Partial<InternalError> = {}): never {
  throw new Refusal({ ok: false, code, message, ...extra })
}

const MINUTE = 60_000
const ALL_DAY: WeeklySchedule = [
  [{ startMinute: 0, endMinute: 1440 }],
  [{ startMinute: 0, endMinute: 1440 }],
  [{ startMinute: 0, endMinute: 1440 }],
  [{ startMinute: 0, endMinute: 1440 }],
  [{ startMinute: 0, endMinute: 1440 }],
  [{ startMinute: 0, endMinute: 1440 }],
  [{ startMinute: 0, endMinute: 1440 }],
]
const PER_DAY_SPREAD = 3

export function createInternalService(deps: InternalServiceDeps): InternalService {
  const { ports, providerDeps } = deps
  const allowedDomains = (deps.allowedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
  const logError = deps.logError ?? ((method, name) => console.error(`[punctual internal] ${method} failed: ${name}`))

  /**
   * The shared pipeline: token, then schema, then actor, then the handler.
   * Every throw becomes a typed result here; nothing raw escapes.
   */
  async function run<S extends z.ZodType, T>(
    method: string,
    raw: unknown,
    schema: S,
    handler: (input: z.output<S>, actor: User, repos: Repositories) => Promise<T>,
  ): Promise<InternalResult<T>> {
    try {
      const presented = isObject(raw) ? raw['token'] : undefined
      const verdict = await verifyServiceToken(deps.serviceToken, presented)
      if (verdict === 'not_configured') {
        return { ok: false, code: 'SERVICE_NOT_CONFIGURED', message: 'internal API is not configured on this deployment' }
      }
      if (verdict !== 'ok') return { ok: false, code: 'UNAUTHORIZED', message: 'invalid service token' }

      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: 'input failed validation',
          issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
        }
      }
      const input = parsed.data as z.output<S> & { actingUserEmail: string }
      const repos = ports.repositories({ consistency: 'bookmark' })
      const actor = await resolveActor(repos, input.actingUserEmail)
      const value = await handler(input, actor, repos)
      return { ok: true, ...value } as InternalResult<T>
    } catch (err) {
      if (err instanceof Refusal) return err.error
      const name = err instanceof Error ? err.name : typeof err
      logError(method, name)
      if (err instanceof CalendarApiError || needsReconnect(err) || needsSetup(err)) {
        return { ok: false, code: 'PROVIDER_ERROR', message: 'the calendar provider refused or failed the request' }
      }
      return { ok: false, code: 'INTERNAL_ERROR', message: 'internal error' }
    }
  }

  function domainAllowed(email: string): boolean {
    if (allowedDomains.length === 0) return true
    const domain = email.slice(email.lastIndexOf('@') + 1)
    return allowedDomains.includes(domain)
  }

  async function resolveActor(repos: Repositories, email: string): Promise<User> {
    const normalized = normalizeEmail(email)
    const user = domainAllowed(normalized) ? await repos.users.byEmail(normalized) : null
    if (!user) refuse('UNKNOWN_ACTOR', 'acting user is not an active Punctual user')
    return user
  }

  /**
   * THE attendee guard. Normalizes and de-duplicates, drops the actor, caps
   * the count, then requires every remaining address to be an existing
   * Punctual user (and inside the allowed domains when configured). Any
   * outsider refuses the whole request, listing every offending address.
   */
  async function resolveAttendees(repos: Repositories, actor: User, emails: string[]): Promise<User[]> {
    const distinct = [...new Set(emails.map(normalizeEmail))].filter((e) => e !== '' && e !== actor.email.toLowerCase())
    if (distinct.length > MAX_ATTENDEES) {
      refuse('TOO_MANY_ATTENDEES', `at most ${MAX_ATTENDEES} attendees`)
    }
    const found = await Promise.all(
      distinct.map(async (email) => ({ email, user: domainAllowed(email) ? await repos.users.byEmail(email) : null })),
    )
    const external = found.filter((f) => f.user === null).map((f) => f.email)
    if (external.length > 0) {
      refuse('EXTERNAL_ATTENDEE', 'every attendee must be an active Punctual user; nothing was sent', {
        externalEmails: external,
      })
    }
    return found.map((f) => f.user as User)
  }

  /**
   * Fresh busy time per participant: their external read connections (no
   * cache) plus Punctual's own bookings and holds from D1. A participant
   * with no readable calendar, a connection needing reconnect, or any
   * provider error fails the whole call closed, naming only the email.
   */
  async function freshBusy(repos: Repositories, users: User[], range: Interval): Promise<Map<string, Interval[]>> {
    const ids = users.map((u) => u.id)
    const unavailable: string[] = []
    const external = await Promise.all(
      users.map(async (user): Promise<Interval[] | null> => {
        try {
          const { read } = partitionConnections(await repos.connections.listForUser(user.id))
          if (read.length === 0 || read.some((c) => c.syncStatus !== 'ok')) return null
          const out: Interval[] = []
          for (const conn of read) {
            out.push(...(await ports.calendars.get(conn.provider).getBusy(conn, range)))
          }
          return out
        } catch (err) {
          logError('freshBusy', err instanceof Error ? err.name : typeof err)
          return null
        }
      }),
    )
    users.forEach((u, i) => {
      if (external[i] === null) unavailable.push(u.email.toLowerCase())
    })
    if (unavailable.length > 0) {
      refuse('CALENDAR_UNAVAILABLE', 'a participant calendar could not be read; refusing rather than guessing', {
        unavailableEmails: unavailable,
      })
    }
    const [buckets, holds] = await Promise.all([
      repos.slotLocks.busyBuckets(ids, range),
      repos.slotLocks.activeHolds(ids, range, ports.clock.now()),
    ])
    const out = new Map<string, Interval[]>()
    users.forEach((u, i) => {
      out.set(u.id, mergeIntervals(combineBusy(buckets.get(u.id) ?? [], holds.get(u.id) ?? [], external[i] ?? [])))
    })
    return out
  }

  async function writeConnection(repos: Repositories, actor: User): Promise<{ conn: CalendarConnection; calendarId: string }> {
    const conns = (await repos.connections.listForUser(actor.id)).filter(
      (c) => c.calendarIdWrite !== null && c.syncStatus === 'ok',
    )
    const google = conns.find((c) => c.provider === 'google')
    if (google && google.calendarIdWrite) return { conn: google, calendarId: google.calendarIdWrite }
    if (conns.length > 0) refuse('UNSUPPORTED_PROVIDER', 'internal meetings need a Google write calendar')
    refuse('NO_WRITE_CALENDAR', 'connect a Google calendar and choose a calendar to write to')
  }

  function assertOwned(ev: InternalGoogleEvent, actor: User): void {
    if (ev.marker !== '1' || ev.organizerMarker?.toLowerCase() !== actor.email.toLowerCase()) {
      refuse('NOT_OWNER', 'not an internal meeting organized by the acting user')
    }
  }

  function busyEmails(users: User[], busy: Map<string, Interval[]>, slot: Interval, ignore?: Interval): string[] {
    return users
      .filter((u) => {
        let blocks = busy.get(u.id) ?? []
        if (ignore) blocks = subtractIntervals(blocks, [ignore])
        return overlapsAny(slot, blocks)
      })
      .map((u) => u.email.toLowerCase())
  }

  function meetingOut(ev: InternalGoogleEvent, timezone: string, meetUrl: string | null): MeetingOutput {
    return {
      eventId: ev.id,
      htmlLink: ev.htmlLink,
      meetUrl,
      start: iso(ev.start),
      end: iso(ev.end),
      timezone,
      attendees: ev.attendees.map((a) => a.email),
    }
  }

  return {
    findTime: (raw) =>
      run('findTime', raw, findTimeSchema, async (input, actor, repos) => {
        const attendees = await resolveAttendees(repos, actor, input.attendeeEmails)
        const participants = [actor, ...attendees]
        const duration = input.durationMinutes
        const range: Interval = { start: input.windowStart, end: input.windowEnd }
        // A candidate starting near windowEnd runs past it; read busy time for that tail too.
        const busy = await freshBusy(repos, participants, { start: range.start, end: range.end + duration * MINUTE })

        const workingHours = input.workingHoursOnly !== false
        const hosts: HostAvailabilityInput[] = await Promise.all(
          participants.map(async (u) => {
            const schedule = workingHours ? await repos.availability.forUser(u.id) : null
            return {
              hostUserId: u.id,
              required: true,
              availability: schedule ?? { userId: u.id, timezone: 'UTC', weekly: ALL_DAY, overrides: [] },
              busy: busy.get(u.id) ?? [],
            }
          }),
        )

        const slots = computeSlots({
          eventType: syntheticEventType(duration),
          hosts,
          range,
          now: ports.clock.now(),
        })

        return {
          timezone: input.timezone,
          slots: spread(slots, input.timezone).map((s) => ({
            start: iso(s.start),
            end: iso(s.end),
            label: formatInZone(s.start, input.timezone, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }),
          })),
          busy: participants.map((u) => ({
            email: u.email.toLowerCase(),
            blocks: clip(busy.get(u.id) ?? [], range).map((b) => ({ start: iso(b.start), end: iso(b.end) })),
          })),
        }
      }),

    createMeeting: (raw) =>
      run('createMeeting', raw, createMeetingSchema, async (input, actor, repos) => {
        const attendees = await resolveAttendees(repos, actor, input.attendeeEmails)
        if (input.start <= ports.clock.now()) refuse('INVALID_INPUT', 'start must be in the future')
        const { conn, calendarId } = await writeConnection(repos, actor)

        // Scoped to the actor so two staff can never collide on one key.
        const stable = await stableEventIds(`swayq-internal:${actor.id}:${input.idempotencyKey}`)
        const replay = async (): Promise<CreateMeetingOutput> => {
          const existing = await getInternalEvent(providerDeps, conn, calendarId, stable.googleEventId)
          if (!existing) refuse('PROVIDER_ERROR', 'the calendar reported a conflict but the event could not be read back')
          return idempotentReplay(existing, actor, input, calendarId, conn)
        }

        // A retry must not be refused by the busy re-check: the first
        // attempt's own event is what now makes everyone busy.
        const prior = await getInternalEvent(providerDeps, conn, calendarId, stable.googleEventId)
        if (prior) return idempotentReplay(prior, actor, input, calendarId, conn)

        const participants = [actor, ...attendees]
        const slot = { start: input.start, end: input.end }
        const busy = await freshBusy(repos, participants, slot)
        const busyNow = busyEmails(participants, busy, slot)
        if (busyNow.length > 0) refuse('SLOT_BUSY', 'a participant is busy in that slot', { busyEmails: busyNow })

        const outcome = await insertInternalEvent(providerDeps, conn, calendarId, {
          googleEventId: stable.googleEventId,
          conferenceRequestId: `swayq-${stable.short}`,
          title: input.title,
          description: input.description ?? '',
          start: input.start,
          end: input.end,
          timezone: input.timezone,
          attendees: participants.map((u) => u.email.toLowerCase()),
          organizerEmail: actor.email.toLowerCase(),
        })
        if (outcome.kind === 'exists') return replay()
        const meetUrl =
          outcome.event.meetUrl ?? (await resolveInternalMeetUrl(providerDeps, conn, calendarId, outcome.event.id))
        return { ...meetingOut(outcome.event, input.timezone, meetUrl), created: true }
      }),

    listMyMeetings: (raw) =>
      run('listMyMeetings', raw, listMyMeetingsSchema, async (input, actor, repos) => {
        const { conn, calendarId } = await writeConnection(repos, actor)
        const events = await listInternalEvents(providerDeps, conn, calendarId, { start: input.from, end: input.to })
        const mine = events.filter(
          (ev) =>
            ev.status !== 'cancelled' &&
            ev.marker === '1' &&
            ev.organizerMarker?.toLowerCase() === actor.email.toLowerCase(),
        )
        return {
          meetings: mine.map((ev) => ({
            eventId: ev.id,
            title: ev.title,
            start: iso(ev.start),
            end: iso(ev.end),
            htmlLink: ev.htmlLink,
            meetUrl: ev.meetUrl,
            attendees: ev.attendees,
          })),
        }
      }),

    rescheduleMeeting: (raw) =>
      run('rescheduleMeeting', raw, rescheduleMeetingSchema, async (input, actor, repos) => {
        const { conn, calendarId } = await writeConnection(repos, actor)
        const ev = await getInternalEvent(providerDeps, conn, calendarId, input.eventId)
        if (!ev || ev.status === 'cancelled') refuse('NOT_FOUND', 'no such meeting on your calendar')
        assertOwned(ev, actor)
        if (input.start <= ports.clock.now()) refuse('INVALID_INPUT', 'start must be in the future')

        // The update goes to everyone on the event, so the attendee guard
        // applies to the event as it stands now (someone may have added a
        // guest in Google by hand).
        const attendees = await resolveAttendees(
          repos,
          actor,
          ev.attendees.map((a) => a.email),
        )
        const participants = [actor, ...attendees]
        const slot = { start: input.start, end: input.end }
        const busy = await freshBusy(repos, participants, slot)
        // The meeting's own current slot shows as busy for everyone on it;
        // moving it by 15 minutes must not collide with itself.
        const busyNow = busyEmails(participants, busy, slot, { start: ev.start, end: ev.end })
        if (busyNow.length > 0) refuse('SLOT_BUSY', 'a participant is busy in that slot', { busyEmails: busyNow })

        const timezone = input.timezone ?? actor.tz
        const patched = await patchInternalEventTime(providerDeps, conn, calendarId, ev.id, {
          start: input.start,
          end: input.end,
          timezone,
        })
        const out = patched ?? { ...ev, start: input.start, end: input.end }
        return meetingOut(out, timezone, out.meetUrl)
      }),

    cancelMeeting: (raw) =>
      run('cancelMeeting', raw, cancelMeetingSchema, async (input, actor, repos) => {
        const { conn, calendarId } = await writeConnection(repos, actor)
        const ev = await getInternalEvent(providerDeps, conn, calendarId, input.eventId)
        if (!ev) return { eventId: input.eventId, cancelled: false }
        assertOwned(ev, actor)
        if (ev.status === 'cancelled') return { eventId: ev.id, cancelled: false }
        const cancelled = await deleteInternalEvent(providerDeps, conn, calendarId, ev.id)
        return { eventId: ev.id, cancelled }
      }),

    myBookingLinks: (raw) =>
      run('myBookingLinks', raw, myBookingLinksSchema, async (_input, actor, repos) => {
        const base = ports.config.baseUrl.replace(/\/+$/, '')
        const types = await repos.eventTypes.listForUser(actor.id)
        return {
          links: types
            .filter((et) => et.active && et.ownerUserId === actor.id && et.ownerTeamId === null)
            .map((et) => ({
              title: et.title,
              slug: et.slug,
              durationMinutes: et.durationMinutes,
              url: `${base}/${encodeURIComponent(actor.slug)}/${encodeURIComponent(et.slug)}`,
            })),
        }
      }),
  }

  /** The event an earlier call with this key created: return it, or refuse if the key was reused differently. */
  async function idempotentReplay(
    existing: InternalGoogleEvent,
    actor: User,
    input: { start: number; end: number; timezone: string },
    calendarId: string,
    conn: CalendarConnection,
  ): Promise<CreateMeetingOutput> {
    assertOwnedForReplay(existing, actor)
    if (existing.status === 'cancelled') {
      refuse('IDEMPOTENCY_CONFLICT', 'this idempotency key belongs to a meeting that was cancelled')
    }
    if (existing.start !== input.start || existing.end !== input.end) {
      refuse('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different time')
    }
    const meetUrl = existing.meetUrl ?? (await resolveInternalMeetUrl(providerDeps, conn, calendarId, existing.id))
    return { ...meetingOut(existing, input.timezone, meetUrl), created: false }
  }

  function assertOwnedForReplay(ev: InternalGoogleEvent, actor: User): void {
    if (ev.marker !== '1' || ev.organizerMarker?.toLowerCase() !== actor.email.toLowerCase()) {
      refuse('IDEMPOTENCY_CONFLICT', 'this idempotency key collides with an event that is not yours')
    }
  }
}

// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function clip(blocks: Interval[], range: Interval): Interval[] {
  const out: Interval[] = []
  for (const b of blocks) {
    const start = Math.max(b.start, range.start)
    const end = Math.min(b.end, range.end)
    if (start < end) out.push({ start, end })
  }
  return out
}

/** A collective "event type" for the slot engine: no buffers, no notice, no cap. */
function syntheticEventType(durationMinutes: number): EventType {
  return {
    id: 'internal',
    ownerUserId: null,
    ownerTeamId: null,
    schedulingType: 'collective',
    slug: 'internal',
    title: 'internal',
    description: '',
    durationMinutes,
    slotIntervalMinutes: Math.min(durationMinutes, 30),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxHorizonDays: 366,
    maxPerDay: null,
    locationType: 'google_meet',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    scheduleId: null,
  }
}

/** Up to MAX_SLOTS, at most PER_DAY_SPREAD per local day first, so "this week" is not ten Monday slots. */
function spread<T extends { start: number }>(slots: T[], timezone: string): T[] {
  const perDay = new Map<string, number>()
  const picked: T[] = []
  const rest: T[] = []
  for (const s of slots) {
    const day = localDateString(s.start, timezone)
    const n = perDay.get(day) ?? 0
    if (n < PER_DAY_SPREAD && picked.length < MAX_SLOTS) {
      picked.push(s)
      perDay.set(day, n + 1)
    } else {
      rest.push(s)
    }
  }
  for (const s of rest) {
    if (picked.length >= MAX_SLOTS) break
    picked.push(s)
  }
  return picked.sort((a, b) => a.start - b.start)
}
