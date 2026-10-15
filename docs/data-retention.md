# Guest data retention and erasure

SwayQ fork (swayq ADR-0082, Linear SWA-1290). Guests are external people who
book a meeting; they have no account. This is what the booking Worker keeps
about them, for how long, and how it is removed.

## The promise

A guest's name, email and free-text answers are kept for
**12 months after the meeting ends** (`GUEST_DATA_RETENTION_MONTHS` in
`src/core/domain/guest-data.ts`), then anonymised. On request an instance
admin can erase a guest immediately.

## Where guest data lives

| Where | What | Retention | Removed by |
|---|---|---|---|
| D1 `bookings` | `guest_name`, `guest_email`, `answers_json`, `guest_timezone`, `guest_locale` | 12 months after `end_utc` | Anonymised in place by the cron; by email on request |
| D1 `idempotency_keys` | `scope` (`booking:<eventTypeId>:<email>`), `response_json` (the booking id only), `request_hash` (a hash of the email) | Own TTL, 24 hours | Deleted by the cron once expired; by email on request |
| D1 `magic_link_tokens` | `email` typed at the sign-in page (may be a non-staff address) | Own TTL, minutes | Deleted by the cron once expired; by email on request, except when the address belongs to a user of this instance (a host's own sign-in tokens are theirs, not a guest's) |
| D1 `guest_erasure_log` | Counts only: who erased, when, how many rows | Kept | Never holds an email, not even hashed |
| Queue `TASKS` / DLQ | Email and sync messages (guest address inside) | Until processed | Message deletion on ack. A DLQ message is not swept: drain the DLQ per the runbook |
| Webhook and Slack/Telegram deliveries | The booking payload, sent out | Not stored here | Outside this app: the receiving side |
| KV `CACHE` | Calendar free/busy only, never a guest | Short TTL | Expires |
| Durable Objects | Holds and rate-limit buckets: ids, no guest data | Short TTL | Alarms |
| Slot locks, holds | Host id, time bucket, booking id | 7 days after the slot | Cron |

There is no outbox, notification-log or audit table that stores a guest's
details. Cloudflare Analytics holds request counts, not identities.

## What anonymisation does

The booking row stays, so the host's history and the stats stay coherent.
Only the person is removed:

- `guest_name` becomes `Erased guest`
- `guest_email` becomes `erased@erased.invalid` (`.invalid` never routes)
- `answers_json` becomes `{}`
- `guest_timezone` becomes `UTC`, `guest_locale` becomes `NULL`

Ids, times, host, event type, status and calendar event ids are kept. The
manage-link token is stored only as a hash and is rotated on every state
change.

## Automatic retention

The five-minute cron (`src/adapters/scheduled.ts`) calls
`purgeExpiredGuestData`. Per tick it anonymises at most 100 bookings that
ended more than 12 calendar months ago (oldest first), deletes at most 100
expired idempotency records and 100 expired login tokens, and logs counts
only. It is idempotent (an anonymised row is never matched again), and a
failing step is logged by name and retried next tick; it never throws out of
the cron.

## Erase a guest on request

Dashboard, **Admin**, **Erase guest data** (`POST /dashboard/admin/erase-guest`).
Instance admins only (a member gets 403), CSRF-protected, needs the confirm
box. For the given email, across all hosts:

1. Every **upcoming confirmed** booking is cancelled first through the normal
   cancel path (two passes, so a booking made meanwhile is caught): the slot
   is released, the guest and the host are emailed, and the calendar sync
   deletes the Google event. If a cancel throws, nothing is erased and the
   page says so ("Could not cancel an upcoming meeting").
2. Then ONE atomic database batch anonymises every other booking for that
   email (any status, any host), deletes the idempotency records for that
   email, deletes its login tokens (unless it is a user's address), and writes
   the audit line. If the batch fails it rolls back completely: nothing is
   erased, no audit line exists, and the page says "rolled back". The batch
   never touches an upcoming confirmed booking, so a cancel that lost a race
   leaves that booking whole; the page then answers 409 with how many remain,
   and repeating the action finishes the job.
3. The audit line in `guest_erasure_log` holds actor, time and counts. The
   email is deliberately not recorded.

The email must be a valid address (the same check as the booking form). The email match is case-insensitive.

## Outside this app (operator steps)

**Google Calendar.** A booking creates an event in the host's Google
Calendar with the guest's name, email and answers in the attendees and
description. Cancelling a future booking removes it. Events for meetings that
already happened stay in the staff member's SwayQ Google Workspace calendar,
under SwayQ's Workspace retention, and this app does not touch them. To
honour an erasure request fully, after running the erase action:

1. Ask the host (or use Workspace admin tools) to search their calendar for
   the guest's email and delete the matching past events.
2. For a Workspace-wide search, an admin can search calendar events by
   attendee in the Google Admin console / Calendar audit tooling and delete
   them.

The erase action's confirmation says this too.

**Resend (email provider).** Confirmation, reminder and cancellation emails
sent to the guest are logged at Resend (recipient address, subject, delivery
status) under Resend's own retention. To remove them, delete the emails from
the Resend dashboard (Emails, search by recipient) or ask Resend support.
This app cannot do it.

**Backups.** D1 Time Travel keeps point-in-time history for 30 days; erased
data ages out of it on that schedule and is not restored selectively.
