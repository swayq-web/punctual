/**
 * The composition root (ADR-0003 §1).
 *
 * `createEngine(ports)` is the ONLY way the engine is constructed. Nothing
 * inside reaches for a global binding, which is precisely what lets the cloud
 * control-plane supply tenant-scoped repositories without the engine knowing
 * tenants exist.
 */

import type { EnginePorts, Repositories, RequestScope } from './ports.js'
import { buildRouter } from './http/router.js'
import { bookingFootprint, computeSlots, type HostAvailabilityInput } from './core/slots/engine.js'
import type { EventType, Interval, Schedule, Slot, User } from './core/domain/types.js'
import { combineBusy, partitionConnections } from './core/domain/booking-service.js'
import { hostSettings } from './core/domain/hosts.js'
import { localDateString, localTimeToInstant } from './core/time/zone.js'
import { needsReconnect } from './adapters/oauth.js'

export interface Engine {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>
  /** Direct domain access for embedders and for the cloud control-plane. */
  slots: SlotService
}

export interface SlotService {
  forEventType(input: {
    eventType: EventType
    hostUsers: User[]
    range: Interval
    scope?: RequestScope
    /**
     * Called once per unreadable host whose failure can block EVERY slot
     * (the personal host, a required collective host, or every round-robin
     * member when none could be read). An unreadable host contributes NO
     * slots (busy for the whole range, never free), so a caller that gets an
     * empty list can tell "nothing free" apart from "we could not check".
     */
    onCalendarUnavailable?: (hostUserId: string) => void
  }): Promise<Slot[]>
}

export interface EngineDeps {
  ports: EnginePorts
}

export function createEngine(ports: EnginePorts): Engine {
  const slots = createSlotService(ports)
  const app = buildRouter(ports, slots)

  return {
    fetch: async (request, env, ctx) => app.fetch(request, env as never, ctx),
    slots,
  }
}

/**
 * The schedule a host's slots are drawn from for one event type — shared by
 * BOTH the listing path (`createSlotService.forEventType` below) and the
 * commit-time re-check (`adapters/coordinator.ts`'s `buildHostInputs`). The
 * two used to disagree: a fix applied only here once left the commit path
 * still validating against the host's default schedule regardless of what
 * was assigned, so a guest booking a real, currently-listed slot on an
 * assigned schedule could 409, while a slot the assigned schedule never
 * offered could still commit. One function, one behavior, both call sites.
 *
 * `scheduleId` is only ever written for a personal event type
 * (dashboard-routes.ts/rest.ts refuse it on a team-owned one), so this needs
 * no `schedulingType` branch — for a team event it's always null and every
 * host falls through to their own default, unchanged. Scoped by `userId`
 * (not just the id) so an assigned schedule can never resolve to a
 * different host's row.
 */
export async function resolveSchedule(
  repos: Repositories,
  userId: string,
  scheduleId: string | null,
): Promise<Schedule | null> {
  if (!scheduleId) return repos.availability.forUser(userId)
  const assigned = await repos.availability.byId(userId, scheduleId)
  return assigned ?? repos.availability.forUser(userId)
}

/**
 * Assembling a host's availability picture.
 *
 * Note where each input comes from, because it is the ADR-0006 §1 rule in
 * code: own bookings and holds are read from D1 (strongly consistent, and the
 * writes users notice immediately), external calendars from KV-cached freeBusy
 * (advisory, re-checked before commit).
 */
export function createSlotService(ports: EnginePorts): SlotService {
  return {
    async forEventType({ eventType, hostUsers, range, scope, onCalendarUnavailable }) {
      const repos = ports.repositories(scope ?? { consistency: 'unconstrained' })
      const hostIds = hostUsers.map((u) => u.id)
      if (hostIds.length === 0) return []

      // computeSlots grids each availability window at its OWN unclipped
      // boundary and only filters candidate STARTS to `range` afterward (see
      // core/slots/engine.ts) — so a candidate's buffered footprint (its
      // start minus bufferBefore, its end plus bufferAfter) can legitimately
      // land outside `range` while the start itself stays inside it. Busy
      // data queried only for `range` would then miss real conflicts sitting
      // just outside it, and a listing could advertise a start that
      // deterministically 409s at commit. The exact bound: every candidate
      // start is itself within `range` (computeSlots filters on that), so its
      // footprint can extend earlier by at most bufferBefore, and later by at
      // most the event's own duration plus bufferAfter — `bookingFootprint`
      // applied to `range.start` and `range.end` pushed out by the duration.
      const busyRange = bookingFootprint(
        range.start,
        range.end + eventType.durationMinutes * 60_000,
        eventType,
      )

      const [busyByHost, holdsByHost, settings] = await Promise.all([
        repos.slotLocks.busyBuckets(hostIds, busyRange),
        repos.slotLocks.activeHolds(hostIds, busyRange, ports.clock.now()),
        hostSettings(repos, eventType),
      ])

      // Per-host reads run concurrently rather than in an await loop: with N
      // hosts the sequential version costs N x (availability + connections)
      // round trips, and round-trip count is what the latency budget is spent
      // on (ADR-0007, and the measurement in EventTypeRepository).
      const failedHostIds: string[] = []
      const built: Array<HostAvailabilityInput | null> = await Promise.all(
        hostUsers.map(async (user) => {
          // A team host's per-event schedule (event_type_hosts) wins over
          // the event type's own scheduleId, which is only ever set for a
          // personal event type anyway; both fall through to the default.
          const own = settings.get(user.id)
          const [availability, external] = await Promise.all([
            resolveSchedule(repos, user.id, own?.scheduleId ?? eventType.scheduleId),
            externalBusyFor(ports, repos, user.id, busyRange),
          ])
          if (!availability) return null
          if (external === CALENDAR_UNAVAILABLE) failedHostIds.push(user.id)
          const perDay = await perDayCounts(repos, user, range, eventType, availability.timezone)
          return {
            hostUserId: user.id,
            required: own?.required ?? true,
            availability,
            busy: combineBusy(
              busyByHost.get(user.id) ?? [],
              holdsByHost.get(user.id) ?? [],
              // Fail CLOSED (SWA-1285): an unreadable calendar makes the host
              // busy for the whole queried range. For a personal event that
              // is zero slots; for a collective event a required host blocks
              // every slot and an optional one never joins; for round-robin
              // the other members still list. Same semantics as the commit
              // path in adapters/coordinator.ts.
              external === CALENDAR_UNAVAILABLE ? [busyRange] : external,
            ),
            bookingsPerLocalDate: perDay,
          }
        }),
      )
      const hosts = built.filter((h): h is HostAvailabilityInput => h !== null)

      // Report only failures that can account for an EMPTY list on their
      // own, so the page never blames the calendar for a month that is
      // genuinely full: the personal host, a REQUIRED collective host, or
      // round-robin when no member could be read at all. An optional
      // collective host, or one unreadable round-robin member beside a
      // readable one, cannot block every slot.
      if (onCalendarUnavailable && failedHostIds.length > 0) {
        const blocking =
          eventType.schedulingType === 'round_robin'
            ? failedHostIds.length === hosts.length
              ? failedHostIds
              : []
            : failedHostIds.filter((id) => settings.get(id)?.required !== false)
        for (const id of blocking) onCalendarUnavailable(id)
      }

      return computeSlots({ eventType, hosts, range, now: ports.clock.now() })
    },
  }
}

/** Sentinel: at least one of the host's calendars could not be read. */
const CALENDAR_UNAVAILABLE = Symbol('calendar_unavailable')

/**
 * External calendar busy time, via the freeBusy cache.
 *
 * A provider failure (outage, per-calendar freeBusy error, revoked grant)
 * returns `CALENDAR_UNAVAILABLE`, and the caller treats the host as busy for
 * the whole range. It used to degrade to an EMPTY busy set, on the theory
 * that the commit-time re-check would catch any conflict; but that re-check
 * read the same failing provider and also proceeded blind, so an outage let a
 * booking land on top of a real meeting. An outage must never produce a
 * double booking, so both paths now fail closed (SWA-1285).
 *
 * Only SUCCESSFUL reads are cached. A failure is never cached as "no busy
 * time", so the next request after the provider recovers reads it live.
 */
async function externalBusyFor(
  ports: EnginePorts,
  repos: ReturnType<EnginePorts['repositories']>,
  userId: string,
  range: Interval,
): Promise<Interval[] | typeof CALENDAR_UNAVAILABLE> {
  const connections = await repos.connections.listForUser(userId)
  const { read } = partitionConnections(connections)
  if (read.length === 0) return []

  const out: Interval[] = []
  let failed = false
  for (const conn of read) {
    const key = `fb:${conn.id}:${range.start}:${range.end}`
    const cached = await ports.cache.get<Interval[]>(key)
    if (cached) {
      out.push(...cached)
      continue
    }
    try {
      const provider = ports.calendars.get(conn.provider)
      const busy = await provider.getBusy(conn, range)
      // 60 s TTL, the spec's number, and also KV's own minimum.
      await ports.cache.put(key, busy, 60)
      out.push(...busy)
    } catch (err) {
      failed = true
      // A REVOKED grant never recovers on its own: record it so the
      // connections page shows a reconnect prompt instead of a green badge.
      if (needsReconnect(err)) {
        await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
      }
    }
  }
  return failed ? CALENDAR_UNAVAILABLE : out
}

/** Per-day booking counts, only when the event type actually caps them. */
async function perDayCounts(
  repos: ReturnType<EnginePorts['repositories']>,
  user: User,
  range: Interval,
  eventType: EventType,
  availabilityTz: string,
): Promise<Map<string, number> | undefined> {
  if (eventType.maxPerDay == null) return undefined
  const counts = new Map<string, number>()
  const bookings = await repos.bookings.listForHost(user.id, range)
  for (const b of bookings) {
    // Recomputed from `startUtc` in THIS host's own availability timezone —
    // never `b.localDate`. That column is stamped once, in the PRIMARY
    // host's timezone (booking-service.ts), so for a collective booking's
    // non-primary hosts it can name the wrong calendar day near a timezone
    // boundary and undercount their cap.
    const date = localDateString(b.startUtc, availabilityTz)
    counts.set(date, (counts.get(date) ?? 0) + 1)
  }
  return counts
}

/**
 * Which days in a month have any bookable slot.
 *
 * Computed from the same pipeline as the slot list so the calendar can never
 * show a day as available that then turns out to have nothing.
 */
export function daysWithSlots(slots: Slot[], timezone: string): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const s of slots) map.set(localDateString(s.start, timezone), true)
  return map
}

/** The UTC range covering a host-local month. */
export function monthRange(month: string, timezone: string): Interval {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const nextMonth = new Date(Date.UTC(y, m, 1))
  const next = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`
  return {
    start: localTimeToInstant(first, 0, timezone),
    end: localTimeToInstant(next, 0, timezone),
  }
}

/** The UTC range covering one host-local day — NOT start + 24h (DST). */
export function dayRange(date: string, timezone: string): Interval {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  return {
    start: localTimeToInstant(date, 0, timezone),
    end: localTimeToInstant(nextDate, 0, timezone),
  }
}
