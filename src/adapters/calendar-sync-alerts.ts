/**
 * Tell the hosts (every host on the booking) that a booking's calendar
 * events failed to sync or drifted, and the instance admins about failures.
 *
 * Never the guest: what went wrong on a host's calendar is internal. The
 * guest learns only what to do, on the manage page (core/domain/calendar-sync.ts).
 *
 * Sent through the queue like every other email, so a mail provider's bad
 * minute is retried rather than losing the alert. Callers make the alert
 * once-only by sending it only when their conditional state move
 * (`markCalendarSyncFailed`, `markCalendarDrifted`) returned true.
 *
 * Plain English for now; i18n of these strings belongs with the template work.
 */

import type { Booking, CalendarSyncErrorCategory, User } from '../core/domain/types.js'
import type { EnginePorts, Repositories } from '../ports.js'
import { describeSyncError } from '../core/domain/calendar-sync.js'
import { escapeHtml } from '../core/email-templates.js'
import { formatInZone } from '../core/time/zone.js'

export type CalendarSyncAlert =
  | {
      kind: 'failed'
      category: CalendarSyncErrorCategory | null | undefined
      /** Which write failed: the advice differs (add it by hand, update it by hand, remove it). Absent reads as create. */
      action?: 'create' | 'update' | 'delete'
    }
  | { kind: 'drifted'; reason: 'moved' | 'deleted' }

export async function alertCalendarSync(
  ports: EnginePorts,
  repos: Repositories,
  booking: Booking,
  alert: CalendarSyncAlert,
): Promise<void> {
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  const title = eventType?.title ?? 'A meeting'
  const link = `${ports.config.baseUrl.replace(/\/$/, '')}/dashboard/bookings/${encodeURIComponent(booking.id)}`

  const recipients = new Map<string, User>()
  for (const id of booking.hostUserIds.length > 0 ? booking.hostUserIds : [booking.hostUserId]) {
    const u = await repos.users.byId(id)
    if (u?.email) recipients.set(u.email.toLowerCase(), u)
  }
  // A failure is the instance's problem too (a revoked app, a disabled API);
  // a drift is the host's own calendar edit, so only the hosts hear of it.
  if (alert.kind === 'failed') {
    for (const u of await repos.users.listAll()) {
      if (u.role === 'admin' && u.email) recipients.set(u.email.toLowerCase(), u)
    }
  }

  for (const user of recipients.values()) {
    const when = formatInZone(booking.startUtc, user.tz || 'UTC')
    const subject =
      alert.kind === 'failed'
        ? `Calendar sync failed: ${title}, ${when}`
        : `Meeting changed outside ${ports.config.brandName}: ${title}, ${when}`
    const lines =
      alert.kind === 'failed'
        ? failedLines(alert.action ?? 'create', title, when, alert.category)
        : [
            alert.reason === 'deleted'
              ? `The calendar event for "${title}" on ${when} was deleted from the calendar, but the booking is still confirmed here.`
              : `The calendar event for "${title}" on ${when} was moved on the calendar, so it no longer matches the booking here.`,
            'The guest can no longer reschedule or cancel it from their link and has been asked to contact you.',
            'Reschedule or cancel the booking from your dashboard so both agree again.',
          ]
    const text = `${lines.join('\n\n')}\n\n${link}\n`
    const html =
      lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
      `<p><a href="${escapeHtml(link)}">Open the booking</a></p>`
    await ports.queue.send({
      kind: 'email',
      message: { to: user.email, ...(user.name ? { toName: user.name } : {}), subject, html, text },
    })
  }
}

/**
 * The failed alert, per write. A failed DELETE is the opposite problem to a
 * failed create: the meeting is cancelled but its event is still on the
 * calendar, so "add it by hand" would be exactly wrong.
 */
function failedLines(
  action: 'create' | 'update' | 'delete',
  title: string,
  when: string,
  category: CalendarSyncErrorCategory | null | undefined,
): string[] {
  switch (action) {
    case 'delete':
      return [
        `The booking "${title}" on ${when} was cancelled, but it is still on your calendar.`,
        describeSyncError(category),
        'Remove the event from your calendar by hand so the time shows as free.',
        "The guest's calendar may still show the meeting too, since the cancellation could not be sent from your calendar. Their cancellation email from us has gone out.",
      ]
    case 'update':
      return [
        `The booking "${title}" on ${when} changed, but the calendar event could not be updated to match.`,
        describeSyncError(category),
        'Check the event on your calendar and update it by hand if needed.',
      ]
    case 'create':
      return [
        `The booking "${title}" on ${when} is confirmed, but it could not be written to the calendar.`,
        describeSyncError(category),
        'The guest has their confirmation email. Check the booking and add it to your calendar by hand if needed.',
      ]
  }
}
