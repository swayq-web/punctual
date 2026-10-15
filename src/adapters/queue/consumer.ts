/**
 * Queue consumer: emails, webhooks, calendar sync.
 *
 * Everything here happens AFTER a booking is committed (ADR-0002 §2), so a
 * failure means a missing email or a delayed calendar entry — never a lost
 * booking. That is why each message is acked or retried individually rather
 * than failing the whole batch.
 */

import type { EnginePorts, ExternalEvent, QueueMessage, Repositories } from '../../ports.js'
import type { Booking, CalendarConnection, CalendarSyncErrorCategory, EventType, InviteChannel, User } from '../../core/domain/types.js'
import { issueManageToken } from '../../core/domain/auth-flows.js'
import { calendarDescription, calendarTitle, participantsFor, type Participant } from '../../core/domain/calendar-text.js'
import { hostSettings } from '../../core/domain/hosts.js'
import { channelAad, chatMessage, type ChannelConfig } from '../../core/domain/chat-notify.js'
import { postChatMessage } from '../chat.js'
import { notifyBookingCreated, notifyBookingRescheduled } from '../notify.js'
import { HOLD_CONFIRMATION_DELIVERIES, isRetryableCategory, retryDelaySeconds } from '../../core/domain/calendar-sync.js'
import { CalendarSyncRetryableError, classifyCalendarError, isCalendarSyncRetry, logSync } from '../calendar-sync-errors.js'
import { alertCalendarSync } from '../calendar-sync-alerts.js'

/**
 * The dead-letter queue is recognised by name: `punctual-tasks-dlq` in the
 * shipped wrangler.toml, and any queue named `*-dlq`, so a deployment that
 * renames its queues (wrangler.production.toml) is still routed correctly.
 */
export function isDeadLetterQueue(queueName: string | undefined): boolean {
  return typeof queueName === 'string' && queueName.endsWith('-dlq')
}

export async function handleQueueBatch(batch: MessageBatch, ports: EnginePorts): Promise<void> {
  if (isDeadLetterQueue(batch.queue)) {
    await handleDeadLetterBatch(batch, ports)
    return
  }
  for (const message of batch.messages) {
    try {
      await handleOne(message.body as QueueMessage, ports, { attempts: message.attempts })
      message.ack()
    } catch (err) {
      if (isCalendarSyncRetry(err)) {
        // Already logged as a category by the sync. Backed off, so a 429 is
        // answered by waiting rather than by the next immediate delivery.
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
        continue
      }
      // Retry individually: one bad webhook endpoint must not hold up
      // everyone else's confirmation emails.
      console.error('[punctual] queue message failed', err)
      message.retry()
    }
  }
}

/**
 * Delivery facts the queue knows and the handler does not. `attempts` is
 * Cloudflare's 1-based delivery count; absent on the inline (no-TASKS) path,
 * where there is no redelivery and so nothing to hold anything back for.
 */
export interface Delivery {
  attempts?: number
}

export async function handleOne(msg: QueueMessage, ports: EnginePorts, delivery: Delivery = {}): Promise<void> {
  switch (msg.kind) {
    case 'email':
      await ports.email.send(msg.message)
      return

    case 'webhook':
      await deliverWebhook(msg, ports)
      return

    case 'chat':
      await deliverChat(msg, ports)
      return

    case 'calendar.sync':
      await syncCalendar(msg, ports, delivery)
      return
  }
}

/**
 * The dead-letter consumer: a message that exhausted its retries.
 *
 * Chosen over handling the "last attempt" inside the main consumer because
 * it is the only place that also sees deliveries the main consumer never
 * finished: a Worker that hit its CPU limit or crashed mid-handler never
 * reaches its own catch, but its message still lands here. It also does not
 * have to know `max_retries`, which lives in wrangler config.
 *
 * A calendar sync that gave up marks the booking `failed` (only from
 * `pending`: a later pass may already have synced it) and tells the hosts and
 * the instance admins, once. A create that gave up still owes the guest their
 * confirmation, without a link; the claim keeps that to one email. Other
 * kinds are logged by kind only and dropped, as before (with no consumer
 * they expired in the DLQ unread): their bodies hold rendered emails and
 * webhook payloads, which do not belong in logs.
 */
export async function handleDeadLetterBatch(batch: MessageBatch, ports: EnginePorts): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleDeadLetter(message.body as QueueMessage, ports)
      message.ack()
    } catch (err) {
      console.error('[punctual] dead-letter message failed', err instanceof Error ? err.name : 'unknown')
      message.retry()
    }
  }
}

export async function handleDeadLetter(msg: QueueMessage, ports: EnginePorts): Promise<void> {
  if (msg.kind !== 'calendar.sync') {
    console.error(JSON.stringify({ source: 'punctual.queue', event: 'dead_letter_dropped', kind: msg.kind }))
    return
  }
  const repos = ports.repositories({ consistency: 'bookmark' })
  const booking = await repos.bookings.byId(msg.bookingId)
  if (!booking) return
  // A create for a booking that was cancelled meanwhile was moot anyway.
  if (msg.action === 'create' && booking.status !== 'confirmed') return

  if (await repos.bookings.markCalendarSyncFailed(booking.id, null, { fromPendingOnly: true, at: ports.clock.now() })) {
    const failed = (await repos.bookings.byId(booking.id)) ?? booking
    logSync('error', {
      event: 'sync_failed',
      bookingId: booking.id,
      stage: 'dead_letter',
      category: failed.calendarSyncError ?? 'retries_exhausted',
    })
    await alertCalendarSync(ports, repos, failed, { kind: 'failed', category: failed.calendarSyncError, action: msg.action }).catch(() =>
      logSync('error', { event: 'alert_not_sent', bookingId: booking.id, stage: 'dead_letter' }),
    )
  }
  if (msg.action === 'create') await dispatchConfirmation(booking.id, ports, msg.manageToken)
}

/**
 * Deliver a webhook with an HMAC signature.
 *
 * The signature covers `timestamp.body` rather than the body alone, so a
 * captured payload cannot be replayed indefinitely — the receiver rejects an
 * old timestamp even though the signature is valid.
 */
async function deliverWebhook(
  msg: Extract<QueueMessage, { kind: 'webhook' }>,
  ports: EnginePorts,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const webhook = await repos.webhooks.byId(msg.webhookId)
  if (!webhook || !webhook.active) return

  const body = JSON.stringify({ event: msg.event, data: msg.payload })
  const timestamp = Math.floor(ports.clock.now() / 1000)
  const signature = await hmacHex(webhook.secret, `${timestamp}.${body}`)

  const res = await fetch(webhook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-punctual-event': msg.event,
      'x-punctual-timestamp': String(timestamp),
      'x-punctual-signature': `sha256=${signature}`,
    },
    body,
  })

  if (!res.ok) {
    throw new Error(`webhook ${webhook.url} returned ${res.status}`)
  }
}

/**
 * Post a booking notification to a Slack or Telegram channel. The message
 * is built here, from the booking as it is now, in the channel owner's
 * timezone (a team's: its first member's). A failed post throws, so the
 * queue retries; a channel or booking that is gone is simply done.
 */
async function deliverChat(msg: Extract<QueueMessage, { kind: 'chat' }>, ports: EnginePorts): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const channel = await repos.channels.byId(msg.channelId)
  if (!channel || !channel.active) return
  const booking = await repos.bookings.byId(msg.bookingId)
  if (!booking) return
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return
  const hosts: User[] = []
  for (const id of booking.hostUserIds.length > 0 ? booking.hostUserIds : [booking.hostUserId]) {
    const u = await repos.users.byId(id)
    if (u) hosts.push(u)
  }
  const named = async (ids: string[] | undefined): Promise<string[] | undefined> => {
    if (!ids) return undefined
    const out: string[] = []
    for (const id of ids) {
      const u = hosts.find((h) => h.id === id) ?? (await repos.users.byId(id))
      out.push(u ? u.name || u.slug : id)
    }
    return out
  }
  let tz = hosts[0]?.tz ?? 'UTC'
  if (channel.ownerKind === 'user') tz = (await repos.users.byId(channel.ownerId))?.tz ?? tz
  const config = JSON.parse(await ports.crypto.decrypt(channel.configEncrypted, channelAad(channel.ownerKind, channel.ownerId, channel.id), channel.keyVersion)) as ChannelConfig
  const message = chatMessage({
    event: msg.event,
    booking,
    eventType,
    hosts,
    tz,
    link: `${ports.config.baseUrl.replace(/\/$/, '')}/dashboard/bookings/${booking.id}`,
    ...(msg.extra?.hostsAdded ? { hostsAdded: await named(msg.extra.hostsAdded) } : {}),
    ...(msg.extra?.hostsRemoved ? { hostsRemoved: await named(msg.extra.hostsRemoved) } : {}),
  })
  const result = await postChatMessage(config, message)
  if (!result.ok) throw new Error(`chat notification to ${channel.label} failed: ${result.detail}`)
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Push the booking to the hosts' external calendars.
 *
 * ONE event per booking per provider (ADR-0011). For each provider, the
 * first host in booking order with a writable, healthy connection is the
 * organizer: their connection creates the event, and every host who belongs
 * on that provider is an attendee of it — so co-hosts see each other and
 * each other's responses on one shared event, instead of N events each
 * inviting the other N-1. A host with connections only on the other
 * provider is an attendee there instead; a host with no connection at all
 * is listed on the primary provider's event by address — which lands on
 * their calendar only if that address is an account there, so it is a
 * courtesy on top of the host confirmation email that already carries the
 * .ics, not the delivery path (the guest's invitation is Google's own,
 * sendUpdates=all, for a Google-channel booking). Optional hosts are flagged optional in the invite.
 *
 * Per-provider failure is tolerated: the organizer's expired Google token
 * must not stop the event landing in Outlook. Tolerated is not ignored
 * (SWA-1286): each failure is classified (adapters/calendar-sync-errors.ts);
 * a retryable one rethrows for a queue retry with backoff, a permanent one
 * marks the booking `failed` and alerts the hosts, and a clean pass marks it
 * `synced` (migration 0018).
 *
 * `externalEventIds` stays keyed by connection id. Cancel and reschedule
 * walk the STORED ids rather than re-deriving the plan, so bookings written
 * before this change — one event per host connection — still cancel and
 * move correctly.
 */
async function syncCalendar(
  msg: Extract<QueueMessage, { kind: 'calendar.sync' }>,
  ports: EnginePorts,
  delivery: Delivery,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const booking = await repos.bookings.byId(msg.bookingId)
  if (!booking) return
  const stage = msg.action
  const attempt = delivery.attempts !== undefined ? { attempt: delivery.attempts } : {}

  /**
   * Every per-connection failure, classified. A failure is still caught per
   * connection (one host's expired token must not stop another's event), but
   * it is no longer swallowed: `settle` turns the list into a retry, a
   * `failed` booking plus an alert, or `synced`.
   */
  const failures: Array<{ connectionId: string; category: CalendarSyncErrorCategory }> = []
  const recordFailure = async (conn: CalendarConnection, err: unknown): Promise<void> => {
    const category = classifyCalendarError(err)
    failures.push({ connectionId: conn.id, category })
    // The category, never the error: a provider body can echo attendee
    // addresses back.
    logSync('warn', { event: 'connection_failed', bookingId: booking.id, stage, category, connectionId: conn.id, provider: conn.provider, ...attempt })
    // A revoked grant will fail every future sync too; record it so the
    // host is prompted rather than quietly losing calendar writes.
    if (category === 'needs_reconnect') {
      await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
    }
  }

  /**
   * Turn this pass's failures into the booking's sync state. Any retryable
   * failure wins: the message is retried (creates are idempotent by stored
   * id and by stable provider event id, so the connections that succeeded
   * are skipped next time). Otherwise a permanent failure marks the booking
   * `failed` now, without burning retries, and tells the host once.
   */
  const settle = async (opts: { clearDrift: boolean }): Promise<'synced' | 'failed' | 'retry'> => {
    const retryable = failures.find((f) => isRetryableCategory(f.category))
    if (retryable) {
      await repos.bookings.recordCalendarSyncRetry(booking.id, retryable.category, ports.clock.now())
      logSync('warn', { event: 'retry_scheduled', bookingId: booking.id, stage, category: retryable.category, ...attempt })
      return 'retry'
    }
    const permanent = failures[0]
    if (permanent) {
      if (await repos.bookings.markCalendarSyncFailed(booking.id, permanent.category, { at: ports.clock.now() })) {
        logSync('error', { event: 'sync_failed', bookingId: booking.id, stage, category: permanent.category, ...attempt })
        const current = (await repos.bookings.byId(booking.id)) ?? booking
        await alertCalendarSync(ports, repos, current, { kind: 'failed', category: permanent.category, action: stage }).catch(() =>
          logSync('error', { event: 'alert_not_sent', bookingId: booking.id, stage }),
        )
      }
      return 'failed'
    }
    await repos.bookings.markCalendarSynced(booking.id, ports.clock.now(), opts)
    return 'synced'
  }
  const retryError = (): CalendarSyncRetryableError =>
    new CalendarSyncRetryableError(booking.id, failures.find((f) => isRetryableCategory(f.category))?.category ?? 'network')
  // A create that is still retrying when the booking gets cancelled must not
  // land: the delete already ran against an empty id map, so nothing would ever
  // remove it.
  if (msg.action === 'create' && booking.status !== 'confirmed') return
  // Looked up here, not earlier: a DELETE needs only externalEventIds, and
  // bailing on a missing event type meant deleting an event type stranded its
  // bookings' calendar entries forever.
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType && msg.action !== 'delete') return
  // Accumulated across every provider, then persisted once.
  const createdIds: Record<string, string> = { ...booking.externalEventIds }
  // Which calendar each event went to, so the drift check reads it back
  // from there and not from whatever the host's write calendar is later.
  const createdCalendars: Record<string, string> = { ...booking.externalEventCalendars }

  // ---- delete: the stored events, whatever shape they were written in ----
  if (msg.action === 'delete') {
    for (const [connId, externalId] of Object.entries(booking.externalEventIds)) {
      const conn = await repos.connections.byId(connId)
      if (!conn) {
        // The connection row is gone, so there is no way to reach the event.
        // That is a permanent failure the host must hear about (the meeting is
        // still on the guest's and host's calendar), never a silent id drop:
        // the id stays stored and `settle` marks the booking failed and alerts.
        failures.push({ connectionId: connId, category: 'needs_reconnect' })
        logSync('warn', { event: 'connection_missing', bookingId: booking.id, stage, category: 'needs_reconnect', connectionId: connId, ...attempt })
        continue
      }
      try {
        // The calendar the event was WRITTEN to, not wherever the host points
        // their write calendar today (unknown only for pre-0018 events).
        await ports.calendars.get(conn.provider).deleteEvent(conn, externalId, booking.externalEventCalendars?.[connId])
        // Only drop the id once the provider confirms. Clearing the whole
        // map unconditionally meant one host's expired token discarded
        // another host's id too, leaving that event on a real calendar
        // with nothing left to delete it by.
        delete createdIds[connId]
      } catch (err) {
        await recordFailure(conn, err)
      }
    }
    // Persist what actually got deleted, not an empty map. A per-connection
    // failure is caught above, so an unconditional wipe would orphan that
    // event permanently. A retry then walks only the ids still stored.
    const changed = JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds)
    if (changed) await repos.bookings.setExternalEventIds(booking.id, createdIds)
    if ((await settle({ clearDrift: true })) === 'retry') throw retryError()
    return
  }
  if (!eventType) return

  const plan = await planInvites(repos, booking, eventType)

  // A host whose only write-capable calendar connection is broken drops out
  // of the plan (it keeps `syncStatus === 'ok'` connections only), so without
  // this the pass "succeeds" with nothing written and the booking reads
  // `synced` while no event exists on that host's calendar. Recorded as a
  // permanent `needs_reconnect` failure: alerted once, and re-driven when
  // the host reconnects (adapters/calendar-sync-redrive.ts).
  for (const blocked of await hostsWithBrokenCalendars(repos, booking)) {
    failures.push({ connectionId: blocked.id, category: 'needs_reconnect' })
    logSync('warn', { event: 'host_calendar_unusable', bookingId: booking.id, stage, category: 'needs_reconnect', connectionId: blocked.id, provider: blocked.provider, ...attempt })
  }

  // The first conference link any provider minted. One per booking, not per
  // event: it is the link the GUEST is told to join, and a guest has one
  // meeting to attend however many calendars it was written to.
  let conferenceUrl: string | null = booking.conferenceUrl
  // Tracked separately from `conferenceUrl`: a room that is still being
  // provisioned returns no URL yet, and keying only on the URL meant the next
  // event asked for a SECOND room — so two hosts ended up in different
  // meetings once both resolved. Asked-once is the invariant, not
  // captured-once.
  let conferenceRequested = booking.conferenceUrl !== null
  // Kept so a cancel that raced this pass can be cleaned up below. Waiting
  // for Google to provision a Meet room added up to a second between the
  // event existing in the provider and its id being persisted — long enough
  // for a delete sync to run against a still-empty id map, delete nothing,
  // and leave a real calendar event nothing can ever remove.
  const freshlyCreated: Array<{ conn: CalendarConnection; externalId: string }> = []

  // One title and one description for every copy of this meeting, naming
  // the people and their companies (core/domain/calendar-text.ts).
  const title = calendarTitle(eventType, plan.participants)
  const description = calendarDescription(eventType, booking, plan.participants)
  const externalFor = (conn: CalendarConnection, attendees: ExternalEvent['attendees']): ExternalEvent => ({
    title,
    description,
    // One event per booking per connection (ADR-0011) is the identity the
    // providers key their idempotent creates on, so a redelivery of this
    // message after a failed `setSyncResult` finds the event, not a twin.
    idempotencyKey: `${booking.id}:${conn.id}`,
    start: booking.startUtc,
    end: booking.endUtc,
    attendees,
    timezone: plan.organizerTz.get(conn.id) ?? booking.guestTimezone,
    // Mint a conference only until ONE exists for this booking; every later
    // event reuses it as the location instead.
    createConference: eventType.locationType === 'google_meet' && !conferenceRequested,
    location:
      eventType.locationType === 'in_person'
        ? (eventType.locationValue ?? undefined)
        : (conferenceUrl ?? undefined),
  })

  /**
   * Create the events a plan calls for that do not exist yet, keeping their
   * ids and the conference link. Shared by create and update: a host put
   * on a booking after the fact (core/domain/booking-hosts.ts) can be the
   * first host with a calendar on their provider, and that provider then
   * needs its one event just as it would have at booking time.
   */
  const createMissing = async (targets: typeof plan.events): Promise<void> => {
    for (const target of targets) {
      const { conn, attendees } = target
      // Queues is at-least-once, so this message can arrive twice. Without
      // this guard a redelivery creates a SECOND real calendar event and
      // overwrites the first id, leaving it unreachable by every delete
      // path — a permanent phantom on the host's calendar.
      if (booking.externalEventIds[conn.id]) continue
      try {
        const external = externalFor(conn, attendees)
        if (external.createConference === true) conferenceRequested = true
        const result = await ports.calendars.get(conn.provider).createEvent(conn, external)
        // Keep the id: reschedule and cancel need it, and without it a
        // cancelled meeting stays on the host's real calendar forever.
        createdIds[conn.id] = result.id
        if (conn.calendarIdWrite) createdCalendars[conn.id] = conn.calendarIdWrite
        freshlyCreated.push({ conn, externalId: result.id })
        // Captured on the first event that mints one; `createConference`
        // above is false from here on, so nothing re-mints.
        if (!conferenceUrl && result.conferenceUrl) conferenceUrl = result.conferenceUrl
      } catch (err) {
        await recordFailure(conn, err)
      }
    }
  }

  /**
   * Re-read before persisting: the booking may have been cancelled while
   * this pass was talking to the provider. Persisting ids onto a cancelled
   * booking is worse than useless — the delete sync has already run and
   * found nothing, so nothing would ever remove these events. Removes what
   * this pass created and reports true when that happened.
   */
  const abandonedIfCancelled = async (): Promise<boolean> => {
    const current = await repos.bookings.byId(booking.id)
    if (!current || current.status === 'confirmed') return false
    for (const made of freshlyCreated) {
      await ports.calendars
        .get(made.conn.provider)
        .deleteEvent(made.conn, made.externalId)
        .catch((err) =>
          logSync('error', {
            event: 'orphan_not_removed',
            bookingId: booking.id,
            stage,
            category: classifyCalendarError(err),
            connectionId: made.conn.id,
          }),
        )
    }
    return true
  }

  if (msg.action === 'update') {
    const stored: Array<{ conn: CalendarConnection; externalId: string }> = []
    for (const [connId, externalId] of Object.entries(booking.externalEventIds)) {
      const conn = await repos.connections.byId(connId)
      if (conn) stored.push({ conn, externalId })
    }

    // Which stored event is each provider's ONE event (ADR-0011). Normally
    // the plan's organizer connection holds it. After a host change the
    // organizer may have left the booking: their event STAYS — the guest and
    // the remaining hosts are on it, and deleting it would pull the meeting
    // off every calendar it reached — and is adopted as that provider's
    // event, updated with the new attendee list through the departed host's
    // connection, which is still theirs. They keep a copy on their own
    // calendar and are told to decline it. Only a provider with no event at
    // all gets one created, which is also what makes a redelivered update
    // idempotent: the second pass finds the anchor and updates it.
    //
    // Any other stored event is a legacy per-host one (written before
    // ADR-0011) and keeps its own host and the guest, so an old booking's
    // reschedule does not start multiplying invitations.
    const anchor = new Map<CalendarConnection['provider'], string>()
    for (const target of plan.events) {
      const own =
        stored.find((s) => s.conn.id === target.conn.id) ??
        stored.find((s) => s.conn.provider === target.conn.provider)
      if (own) anchor.set(target.conn.provider, own.conn.id)
    }
    for (const { conn, externalId } of stored) {
      try {
        const planned =
          anchor.get(conn.provider) === conn.id
            ? plan.events.find((e) => e.conn.provider === conn.provider)?.attendees
            : undefined
        // A stored event whose connection belongs to a host who has LEFT the
        // booking, on a provider nobody remaining writes to: the plan has no
        // event for it, yet it is the only calendar event this meeting has.
        // The legacy fallback would put the departed host back on it and
        // leave the remaining hosts off (caught by review); it gets the
        // booking's current people instead, through the departed host's
        // connection, which is still theirs.
        const departed = !booking.hostUserIds.includes(conn.userId) && !plan.events.some((e) => e.conn.provider === conn.provider)
        const attendees = planned ?? (departed ? plan.currentAttendees : await legacyAttendees(repos, booking, conn))
        await ports.calendars.get(conn.provider).updateEvent(conn, externalId, externalFor(conn, attendees), booking.externalEventCalendars?.[conn.id])
      } catch (err) {
        await recordFailure(conn, err)
      }
    }

    await createMissing(plan.events.filter((t) => !anchor.has(t.conn.provider)))
    if (freshlyCreated.length > 0) {
      if (await abandonedIfCancelled()) return
      await repos.bookings.setSyncResult(booking.id, createdIds, conferenceUrl, createdCalendars)
    }
    // An update rewrites every stored event from the booking as it is now,
    // so a clean pass puts a drifted booking back in line.
    if ((await settle({ clearDrift: true })) === 'retry') throw retryError()
    return
  }

  // ---- create: one event per provider ----
  await createMissing(plan.events)
  // Persist whatever succeeded. Partial success is normal — one host's expired
  // token must not discard another host's event id.
  if (msg.action === 'create') {
    if (await abandonedIfCancelled()) return

    // Compare by VALUE, not key count. Counting keys meant a second create for
    // the same connection (same key, new id) looked unchanged, so the newer
    // event id was never stored and the event became undeletable.
    const changed =
      JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds) ||
      conferenceUrl !== booking.conferenceUrl
    if (changed) await repos.bookings.setSyncResult(booking.id, createdIds, conferenceUrl, createdCalendars)

    // A redelivered create that wrote nothing has not looked at the
    // calendar, so it must not clear a drift the reconciler recorded.
    const outcome = await settle({ clearDrift: false })
    // A retryable failure on the FIRST delivery holds the confirmation back
    // briefly (one backoff, ~10 s), so the retry can still put the meeting
    // link in it. Never longer (HOLD_CONFIRMATION_DELIVERIES), and never on
    // the inline path, which has no retry to wait for: a calendar outage
    // must not become an email outage.
    if (outcome === 'retry' && delivery.attempts !== undefined && delivery.attempts <= HOLD_CONFIRMATION_DELIVERIES) {
      throw retryError()
    }

    // The confirmation is dispatched HERE, not by the coordinator, because
    // this is the first point that knows the conference link — and the email
    // body is rendered at enqueue time, so sending it any earlier bakes in a
    // "link to follow" that never gets followed up.
    //
    // Reached on every outcome except a held first delivery (above): every
    // per-connection failure is caught and recorded, and a host with no
    // writable connection simply runs an empty loop. So a calendar outage
    // delays the email by one backoff at most; it then goes out without a
    // link, which is the honest outcome.
    // Throws on failure so `handleQueueBatch` retries rather than acking —
    // the calendar work above is idempotent (guarded by `externalEventIds`),
    // so redelivery is safe. Releasing the claim is `dispatchConfirmation`'s
    // job, because only it knows whether THIS attempt won one.
    await dispatchConfirmation(booking.id, ports, msg.manageToken)
    // Sent (or already sent); the calendar still needs its retry.
    if (outcome === 'retry') throw retryError()
  }
}

/**
 * Which connection creates each provider's event, and who is on it
 * (ADR-0011). Hosts in booking order; the first with a writable, healthy
 * connection on a provider is that provider's organizer. Attendees of a
 * provider's event: the guest, every host with a writable connection on
 * that provider (by their account email too, so a second account of theirs
 * gets the invitation as well), and — on the primary provider only — every
 * host with no writable connection anywhere, by address. Optional hosts
 * carry the flag from `event_type_hosts` as it stands now.
 *
 * The update path (a host change, or a test) matches stored events to
 * this plan by provider — see `syncCalendar` for how an event whose
 * organizer has left the booking is handled.
 */
async function planInvites(
  repos: Repositories,
  booking: Booking,
  eventType: EventType,
): Promise<{
  events: Array<{ conn: CalendarConnection; attendees: ExternalEvent['attendees'] }>
  organizerTz: Map<string, string>
  /** Everyone on the meeting — the guest, then the hosts in booking order — for the event's title and description. */
  participants: Participant[]
  /** The guest and every current host by their account email — for an event that outlived its organizer. */
  currentAttendees: ExternalEvent['attendees']
}> {
  const settings = await hostSettings(repos, eventType)
  const hosts: Array<{ user: User; writable: CalendarConnection[] }> = []
  for (const id of booking.hostUserIds) {
    const user = await repos.users.byId(id)
    if (!user) continue
    const writable = (await repos.connections.listForUser(id)).filter((c) => c.calendarIdWrite && c.syncStatus === 'ok')
    hosts.push({ user, writable })
  }
  const participants = participantsFor(
    eventType,
    booking,
    hosts.map((h) => ({ user: h.user, optional: settings.get(h.user.id)?.required === false })),
  )
  const providers = [...new Set(hosts.flatMap((h) => h.writable.map((c) => c.provider)))]
  const unconnected = hosts.filter((h) => h.writable.length === 0)
  const events: Array<{ conn: CalendarConnection; attendees: ExternalEvent['attendees'] }> = []
  const organizerTz = new Map<string, string>()
  providers.forEach((provider, index) => {
    const organizer = hosts.find((h) => h.writable.some((c) => c.provider === provider))
    if (!organizer) return
    const conn = organizer.writable.find((c) => c.provider === provider)!
    const attendees: ExternalEvent['attendees'] = [{ email: booking.guestEmail, name: booking.guestName }]
    const seen = new Set<string>([booking.guestEmail.toLowerCase()])
    const add = (email: string, name: string, optional: boolean) => {
      const key = email.toLowerCase()
      if (!email || seen.has(key)) return
      seen.add(key)
      attendees.push({ email, name, ...(optional ? { optional: true } : {}) })
    }
    for (const h of hosts) {
      const optional = settings.get(h.user.id)?.required === false
      const onThisProvider = h.writable.filter((c) => c.provider === provider)
      if (onThisProvider.length > 0) {
        add(h.user.email, h.user.name || h.user.slug, optional)
        for (const c of onThisProvider) add(c.providerAccountEmail, h.user.name || h.user.slug, optional)
      } else if (index === 0 && unconnected.includes(h)) {
        add(h.user.email, h.user.name || h.user.slug, optional)
      }
    }
    events.push({ conn, attendees })
    organizerTz.set(conn.id, organizer.user.tz)
  })
  const currentAttendees: ExternalEvent['attendees'] = [{ email: booking.guestEmail, name: booking.guestName }]
  for (const h of hosts) {
    const optional = settings.get(h.user.id)?.required === false
    if (h.user.email && h.user.email.toLowerCase() !== booking.guestEmail.toLowerCase()) {
      currentAttendees.push({ email: h.user.email, name: h.user.name || h.user.slug, ...(optional ? { optional: true } : {}) })
    }
  }
  return { events, organizerTz, participants, currentAttendees }
}

/**
 * For each booking host whose write-capable connections (a write calendar
 * chosen) are ALL unusable (`needs_reconnect` or `error`), one of those
 * connections. A host with no write calendar at all chose not to have
 * bookings written and is not reported; a host with one healthy connection
 * among broken ones still gets the event through the healthy one.
 */
async function hostsWithBrokenCalendars(repos: Repositories, booking: Booking): Promise<CalendarConnection[]> {
  const out: CalendarConnection[] = []
  for (const id of booking.hostUserIds.length > 0 ? booking.hostUserIds : [booking.hostUserId]) {
    const writeCapable = (await repos.connections.listForUser(id)).filter((c) => c.calendarIdWrite)
    if (writeCapable.length > 0 && !writeCapable.some((c) => c.syncStatus === 'ok')) out.push(writeCapable[0]!)
  }
  return out
}

/** 'google' iff one of the booking's stored events lives on a Google connection. */
async function inviteChannelFor(repos: Repositories, booking: Booking): Promise<InviteChannel> {
  for (const connId of Object.keys(booking.externalEventIds)) {
    if ((await repos.connections.byId(connId))?.provider === 'google') return 'google'
  }
  return 'ics'
}

/** A pre-ADR-0011 event's attendee list: the guest and the connection's own host. */
async function legacyAttendees(
  repos: Repositories,
  booking: Booking,
  conn: CalendarConnection,
): Promise<ExternalEvent['attendees']> {
  const host = await repos.users.byId(conn.userId)
  return [
    { email: booking.guestEmail, name: booking.guestName },
    ...(host ? [{ email: host.email, name: host.name || host.slug }] : []),
  ]
}

/**
 * Send this booking's confirmation, exactly once, now that the conference
 * link is known.
 *
 * Ownership of this moved out of the coordinator: the coordinator
 * fires immediately after commit, which is BEFORE any calendar event exists,
 * and the email body is rendered at enqueue time — so the link could never
 * make it in from there no matter how the queue happened to interleave.
 *
 * Exported so a route can fall back to it directly when its queue send
 * fails: for a reschedule that message is now the ONLY one, so losing it
 * would cost the guest both the calendar event and the email. The claim
 * inside makes the fallback and a later redelivery mutually exclusive.
 *
 * The manage token arrives on the message rather than being re-issued here.
 * Re-issuing looks safer — only the hash is stored, so the raw token is
 * otherwise unrecoverable — but it is actively wrong: the coordinator hands
 * that same token to the just-booked page, whose "Reschedule or cancel"
 * button embeds it, so rotating the stored hash kills a link the guest is
 * already looking at, seconds after they were shown it. And carrying it adds
 * no exposure: the rendered confirmation email already contains this token
 * and is itself a queue message.
 */
export async function dispatchConfirmation(
  bookingId: string,
  ports: EnginePorts,
  manageToken: string | undefined,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })

  let booking = await repos.bookings.byId(bookingId)
  if (!booking || booking.status !== 'confirmed') return
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return
  const host = await repos.users.byId(booking.hostUserId)
  if (!host) return
  const hosts = (await Promise.all(booking.hostUserIds.map((id) => repos.users.byId(id)))).filter(
    (u): u is NonNullable<typeof u> => u !== null,
  )

  // A reschedule's replacement leg gets the "Rescheduled" mail, not
  // "Confirmed" — `notifyBookingCreated` early-returns on `rescheduleOf` for
  // exactly this reason, so branching here is what makes the new leg's link
  // reach the guest at all.
  let previous: Booking | null = null
  if (booking.rescheduleOf) {
    previous = await repos.bookings.byId(booking.rescheduleOf)
    if (!previous) return
    // Only the reschedule that actually WON may mail, and only once the win
    // is recorded. Two racing reschedules both create a replacement, but
    // `markRescheduled` lets exactly one point the original at its
    // replacement; the loser is cancelled moments later by its own route.
    //
    // This is ALSO not-yet-landed on the first pass: on the inline
    // (no-TASKS) path the sync runs synchronously inside `coordinator.book`,
    // before the route has marked anything. Declining here — crucially
    // WITHOUT claiming — is what lets the route's second pass do the real
    // notification. Claiming first would burn the one claim on a pass that
    // deliberately sends nothing, and the reschedule mail would never go out.
    if (previous.rescheduledTo !== booking.id) return
  }

  // Claimed as late as possible, but still before sending: Queues is
  // at-least-once, so a redelivery must not send a second confirmation.
  if (!(await repos.bookings.claimConfirmation(bookingId, ports.clock.now()))) return

  // Released ONLY on a claim this attempt won. Releasing from an outer catch
  // was wrong in a way that undoes the migration backfill: an attempt that
  // threw BEFORE claiming would clear a claim someone else holds — including
  // the one the backfill wrote for a booking the old code path had already
  // confirmed — and the retry would then send that guest a second
  // confirmation for a meeting they already know about.
  try {
    // No token on the message means nobody holds a link for this booking:
    // the reconciler re-enqueued a create whose original message never ran
    // (only the token's HASH is stored, so the raw one is gone). Issue a
    // fresh one so this confirmation carries a working manage link. Only
    // here, after winning the claim: the normal path always carries the
    // coordinator's token, and rotating that would kill the link the
    // just-booked page is showing (see the doc comment above).
    if (!manageToken) {
      const issued = await issueManageToken({ crypto: ports.crypto }, booking, 'manage')
      await repos.bookings.rotateManageToken(booking.id, issued.tokenHash)
      manageToken = issued.token
      logSync('info', { event: 'manage_token_reissued', bookingId: booking.id, stage: 'create' })
    }

    // How this confirmation reaches the guest, recorded as it is sent, so a
    // later cancel or reschedule can follow the same channel: 'google' when
    // a Google event for the booking exists right now (it can carry
    // Google's own invitation), else 'ics' (the attachment on this email).
    const channel = await inviteChannelFor(repos, booking)
    await repos.bookings.setInviteChannel(booking.id, channel)
    // The mail is built from this object, and it decides whether an .ics is attached.
    booking = { ...booking, inviteChannel: channel }

    if (previous) {
      await notifyBookingRescheduled({
        ports,
        booking,
        previous,
        eventType,
        host,
        hosts,
        ...(manageToken ? { manageToken } : {}),
      })
      return
    }
    await notifyBookingCreated({ ports, booking, eventType, host, hosts, ...(manageToken ? { manageToken } : {}) })
  } catch (err) {
    await repos.bookings.releaseConfirmationClaim(bookingId).catch(() => {})
    throw err
  }
}
