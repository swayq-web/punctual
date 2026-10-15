# Internal scheduling API (`InternalApi`)

Staff-to-staff scheduling for a SwayQ deployment of Punctual: find a time for
a few colleagues, send the Google invite with a Meet link, and list, move or
cancel the meetings you organized. The SwayQ app Worker calls it over a
Cloudflare **service binding**, acting as one staff member (SWA-1289).

Source: `src/internal/` (contract in `src/internal/contract.ts`), Google calls
in `src/adapters/google/internal-meetings.ts`, tests in
`test/core/internal-api.test.ts` and `test/workers/internal-entrypoint.test.ts`.

## Wiring

This Worker exports a named entrypoint next to its default export:

```ts
// src/index.ts
export { InternalApi } from './internal/entrypoint.js'
```

The caller binds to it by name (`wrangler.jsonc` of the calling Worker):

```jsonc
"services": [
  { "binding": "PUNCTUAL", "service": "punctual", "entrypoint": "InternalApi" }
]
```

and calls methods directly over RPC:

```ts
const res = await env.PUNCTUAL.findTime({ token: env.PUNCTUAL_INTERNAL_TOKEN, actingUserEmail, ... })
if (!res.ok) { /* res.code, res.message */ }
```

Secrets and vars on **this** Worker:

| Name | Required | Meaning |
|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | yes | Shared secret the caller passes as `token`. Unset or blank: every call returns `SERVICE_NOT_CONFIGURED`. |
| `INTERNAL_ALLOWED_DOMAINS` | recommended | Comma list of email domains (e.g. `swayq.com`). When set, the actor and every attendee must also be in one of these domains. |

## Security model

1. **Perimeter: the named entrypoint.** A non-default `WorkerEntrypoint` is
   reachable only through a service binding from a Worker in the same
   Cloudflare account. The public `fetch` handler never routes to it; the
   workers test requests plausible paths (`/findTime`,
   `/api/internal/findTime`, `/InternalApi/findTime`, ...) and asserts 404.
2. **Defense in depth: the shared token.** Checked first, in constant time
   (SHA-256 both sides, XOR compare), before the engine is even built. It
   turns a mistaken binding (another Worker in the account) into a refusal
   rather than full staff-calendar access. An unset secret refuses
   everything; there is no "no secret means open" mode.
3. **Acting user.** `actingUserEmail` is trimmed and lowercased, then must be
   an existing Punctual user (and inside `INTERNAL_ALLOWED_DOMAINS` when set).
   Punctual has no disabled flag: removing a user from the instance is how a
   user is deactivated. Anything else is `UNKNOWN_ACTOR`. The caller (SwayQ)
   is trusted to have authenticated the human; this API trusts the
   service binding + token for that assertion.
4. **Attendee guard (the critical invariant).** Every attendee email must be
   an existing Punctual user (and in the allowed domains). One outsider
   refuses the WHOLE request with `EXTERNAL_ATTENDEE`, listing every
   offending address. Nothing is read or sent for anyone. Emails are
   normalized and de-duplicated first; the actor is always a participant and
   is dropped from the attendee list; more than 20 distinct attendees is
   `TOO_MANY_ATTENDEES`. `rescheduleMeeting` re-applies the guard to the
   event's CURRENT attendee list (someone may have added a guest in Google
   by hand), since the update is sent to everyone on it.
5. **Fresh, fail-closed busy time.** `findTime`, `createMeeting` and
   `rescheduleMeeting` read every participant's read connections directly
   (no KV cache) plus Punctual's own bookings and holds in D1. A participant
   with no readable calendar, a connection in `needs_reconnect`/`error`, or
   any provider error fails the call with `CALENDAR_UNAVAILABLE`, naming
   only the email.
6. **Ownership.** Internal meetings live in Google only (no D1 table). Each
   event carries `extendedProperties.private = { swayqInternalMeeting: "1",
   swayqOrganizer: <actor email> }`. Private extended properties exist only
   on the organizer's copy, so reschedule and cancel look the event up on
   the ACTOR's own write calendar and refuse (`NOT_OWNER`) unless both keys
   match the actor. Another user's event is simply not on that calendar
   (`NOT_FOUND`).
7. **No leakage.** Every method returns a typed union and never throws
   across the RPC boundary. Errors never carry tokens, raw provider bodies,
   or other users' event data; logs carry the method and the error NAME
   only.

## Methods

All inputs are plain objects, validated with zod after the token check.
Times are ISO 8601 strings **with an offset** (`2026-10-20T10:00:00+02:00` or
`...Z`); outputs are UTC ISO strings (`2026-10-20T08:00:00.000Z`).
`timezone` is an IANA zone.

```ts
type InternalResult<T> = ({ ok: true } & T) | InternalError

interface InternalError {
  ok: false
  code: InternalErrorCode
  message: string
  externalEmails?: string[]     // EXTERNAL_ATTENDEE
  unavailableEmails?: string[]  // CALENDAR_UNAVAILABLE
  busyEmails?: string[]         // SLOT_BUSY
  issues?: Array<{ path: string; message: string }> // INVALID_INPUT
}

class InternalApi extends WorkerEntrypoint<InternalEnv> {
  findTime(input: {
    token: string
    actingUserEmail: string
    attendeeEmails: string[]          // the actor is always included
    durationMinutes: number           // multiple of 5, 5..480
    windowStart: string               // window <= 31 days
    windowEnd: string
    timezone: string                  // labels are rendered here
    workingHoursOnly?: boolean        // default true
  }): Promise<InternalResult<{
    timezone: string
    slots: Array<{ start: string; end: string; label: string }> // <= 10
    busy: Array<{ email: string; blocks: Array<{ start: string; end: string }> }>
  }>>

  createMeeting(input: {
    token: string
    actingUserEmail: string
    attendeeEmails: string[]
    start: string                     // future; meeting <= 8 h
    end: string
    timezone: string
    title: string                     // 1..200
    description?: string              // <= 8000
    idempotencyKey: string            // 8..200, caller-chosen
  }): Promise<InternalResult<{
    eventId: string
    htmlLink: string | null
    meetUrl: string | null
    start: string
    end: string
    timezone: string
    attendees: string[]               // organizer first
    created: boolean                  // false on an idempotent replay
  }>>

  listMyMeetings(input: {
    token: string
    actingUserEmail: string
    from: string                      // range <= 92 days
    to: string
  }): Promise<InternalResult<{
    meetings: Array<{
      eventId: string
      title: string
      start: string
      end: string
      htmlLink: string | null
      meetUrl: string | null
      attendees: Array<{ email: string; responseStatus: string | null }>
    }>
  }>>

  rescheduleMeeting(input: {
    token: string
    actingUserEmail: string
    eventId: string
    start: string
    end: string
    timezone?: string                 // default: the actor's Punctual tz
  }): Promise<InternalResult<{
    eventId: string
    htmlLink: string | null
    meetUrl: string | null
    start: string
    end: string
    timezone: string
    attendees: string[]
  }>>

  cancelMeeting(input: {
    token: string
    actingUserEmail: string
    eventId: string
  }): Promise<InternalResult<{ eventId: string; cancelled: boolean }>> // false = already gone

  myBookingLinks(input: {
    token: string
    actingUserEmail: string
  }): Promise<InternalResult<{
    links: Array<{ title: string; slug: string; durationMinutes: number; url: string }>
  }>>
}
```

### Behaviour notes

- **findTime** grids candidate starts every `min(duration, 30)` minutes,
  snapped to the 5-minute grid, using the same pure slot engine as booking
  pages (`computeSlots`, collective mode: everyone must be free). With
  `workingHoursOnly` (default) each participant's Punctual default schedule
  bounds the slots; a participant with no schedule is unconstrained. Up to
  10 slots, at most 3 per local day before filling, so "this week" is not
  ten Monday mornings. Busy output is blocks only (start/end), clipped to
  the window; never titles, descriptions or attendees.
- **createMeeting** writes to the actor's Google write calendar
  (`calendarIdWrite` of an `ok` Google connection) with
  `conferenceDataVersion=1`, a Meet `createRequest`, `sendUpdates=all`, and
  attendees = actor + others. The Google event id is derived from
  `swayq-internal:<actorUserId>:<idempotencyKey>` (same derivation as
  booking sync, `adapters/calendar-ids.ts`), so:
  - a retry finds the existing event BEFORE the busy re-check (the first
    attempt's own event is what makes everyone busy) and returns it with
    `created: false`;
  - a race that loses at insert gets Google's 409 and reads the event back;
  - reusing a key for a different time, for a cancelled meeting, or
    colliding with an event that is not the actor's is `IDEMPOTENCY_CONFLICT`.
  The Meet link is polled briefly if Google is still provisioning it;
  `meetUrl: null` means it was not ready, not that there is none.
- **listMyMeetings** lists the actor's write calendar filtered by
  `privateExtendedProperty=swayqInternalMeeting=1`, keeping only events whose
  `swayqOrganizer` is the actor. Attendee copies do not carry the private
  marker, so this is "meetings I organized".
- **rescheduleMeeting** PATCHes start/end only (`sendUpdates=all`, no
  `createRequest`, so the existing Meet link stays). The busy re-check
  ignores the meeting's own current slot, so nudging it by 15 minutes does
  not collide with itself.
- **cancelMeeting** DELETEs with `sendUpdates=all`; 404/410 or an already
  cancelled event returns `cancelled: false`. Cancel does not re-apply the
  attendee guard: a cancellation to a hand-added guest is harmless and
  refusing it would strand the meeting.
- **myBookingLinks** returns the actor's active personal event types as
  `BASE_URL/{userSlug}/{eventSlug}` (team event types are excluded).

## Error codes

| Code | When | Extra fields |
|---|---|---|
| `SERVICE_NOT_CONFIGURED` | `INTERNAL_SERVICE_TOKEN` unset or blank on this Worker | |
| `UNAUTHORIZED` | missing or wrong `token` | |
| `INVALID_INPUT` | schema failure, or a start not in the future | `issues` |
| `UNKNOWN_ACTOR` | actor is not a Punctual user, or outside the allowed domains | |
| `EXTERNAL_ATTENDEE` | any attendee is not a Punctual user (or outside allowed domains) | `externalEmails` |
| `TOO_MANY_ATTENDEES` | more than 20 distinct attendees | |
| `CALENDAR_UNAVAILABLE` | a participant's calendar could not be read | `unavailableEmails` |
| `NO_WRITE_CALENDAR` | actor has no connection with a write calendar | |
| `UNSUPPORTED_PROVIDER` | actor's write calendar is not Google | |
| `SLOT_BUSY` | a participant is busy in the requested slot | `busyEmails` |
| `NOT_FOUND` | no such (non-cancelled) event on the actor's write calendar | |
| `NOT_OWNER` | event lacks the marker or names another organizer | |
| `IDEMPOTENCY_CONFLICT` | key reused for a different time / cancelled / foreign event | |
| `PROVIDER_ERROR` | Google refused or failed (incl. a grant needing reconnect) | |
| `INTERNAL_ERROR` | anything else (engine misconfigured, D1 failure) | |

## Known limits

- Writes are Google-only. A staff member whose write calendar is Microsoft
  gets `UNSUPPORTED_PROVIDER`; their busy time is still read for others.
- "Active user" is "exists in `users`". If signups are open
  (`SIGNUPS` unset), anyone can become a user, so set
  `INTERNAL_ALLOWED_DOMAINS` (or a closed / allowlisted `SIGNUPS`) on any
  deployment that exposes this API.
- `listMyMeetings` reads at most 5 pages of 250 events.
