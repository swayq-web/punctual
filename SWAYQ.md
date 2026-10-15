# SwayQ fork of punctual

This is swayq-web/punctual, a fork of CCCrafts/punctual (MIT) that runs as the
SwayQ booking product: its own Cloudflare Worker, D1, KV and queues, separate
from the main SwayQ Nuxt Worker (swayq ADR-0082, Linear SWA-1290 / SWA-1284).
Durable resources are created by Terraform in the swayq repo
(`infra/cloudflare/booking.tf`); this repo owns the Worker artifact, bindings,
domain routes and deploy.

Never open a PR against CCCrafts/punctual from here.

## Upstream

- Upstream: `CCCrafts/punctual`, pinned at `76dddfd` ("Clip long user agents in
  the Admin traffic lists").
- Merge upstream:
  ```
  git fetch upstream
  git merge <tag-or-sha>
  npm ci && npm run typecheck && npx vitest run
  ```
  Resolve conflicts in the files listed below first. Re-run the dry runs
  (`npx wrangler deploy --dry-run -c wrangler.staging.toml --outdir <dir>`).
- `wrangler.toml` stays the upstream self-host template; SwayQ values live only
  in `wrangler.staging.toml` and `wrangler.production.toml`.
- `.github/workflows/ci.yml` is upstream, test-only, and is kept. Upstream has
  no deploy or publish workflow, so nothing needed disabling.

## SwayQ-modified upstream files

Against the pin `76dddfd` (`git diff --stat 76dddfd origin/main`, 2026-10-16).
Resolve conflicts here first when merging upstream. Files marked (new) do not
exist upstream.

- i18n (new): `src/core/i18n/{index,en,da}.ts`; wired through `src/http/pages/*`, `src/core/email-templates.ts`, `src/http/router.ts`
- Pages and skin: `src/http/pages/{booking,dashboard}.ts`, `src/http/pages/manage.ts` (new), `src/http/swayq-skin.ts` (new), `src/http/streaming.ts`, `src/http/turnstile.ts` (new), `src/http/router.ts`, `src/swayq-surfaces.ts` (new, surface switches), `assets/fonts/*` (Poppins, OFL)
- Email and notifications: `src/core/email-templates.ts`, `src/core/ics.ts`, `src/core/domain/guest-history.ts` (new), `src/adapters/notify.ts`
- Calendar sync (durable, fail-closed): `migrations/0018_calendar_sync_state.sql`, `src/adapters/{calendar-sync-alerts,calendar-sync-errors,calendar-sync-redrive,coordinator,providers,scheduled}.ts`, `src/adapters/d1/{repositories,schema}.ts`, `src/adapters/google/{get-event,internal-meetings,provider}.ts`, `src/adapters/microsoft/{get-event,provider}.ts`, `src/adapters/queue/consumer.ts`, `src/core/domain/{booking-service,calendar-sync,types}.ts`, `src/engine.ts`, `src/ports.ts`, `src/http/{calendar-connect,dashboard-routes}.ts`, `src/http/api/rest.ts`, `src/http/mcp/server.ts`, `src/index.ts`, `src/testing/fakes.ts`
- Internal API (new, service binding to the swayq Worker): `src/internal/{contract,entrypoint,schemas,service,token}.ts`, `docs/internal-api.md`
- Deploy and config: `wrangler.production.toml`, `wrangler.staging.toml` (new), `wrangler.toml` (DLQ consumer block), `.github/workflows/swayq-deploy.yml` (new), `.github/workflows/ci.yml` (token permissions), `.gitignore`, `docs/self-hosting.md`, `SWAYQ.md`
- Hardening (SWA-1290): `src/log-redact.ts` (new, URL redaction), `app.onError` in `src/http/router.ts`, `readSurfaceBody` in `src/swayq-surfaces.ts`
- Avatars: `src/adapters/storage/r2-blob.ts` (null storage when no AVATARS binding), `Env.AVATARS` now optional
- Tests: `test/core/*` and `test/workers/*` for each area above; `test/workers/surface-body-gate.test.ts` and `test/core/log-redact.test.ts` cover the hardening

## Production prerequisites

Tick all of these before the first production deploy.

- [ ] GitHub environments `staging` and `production` exist in swayq-web/punctual. Deployment branches restricted to `main`; `production` has a required reviewer. (The deploy workflow also refuses any ref but `refs/heads/main`.)
- [ ] Environment secrets set in both: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY_V1`, `SIGNING_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `INTERNAL_SERVICE_TOKEN`.
- [ ] `REPLACE_WITH_` placeholders filled in both wrangler configs from `terraform output`.
- [ ] `workers_dev = false` and `preview_urls = false` stay set in both configs, so the Worker answers only on its custom domain. After the first deploy confirm `https://swayq-booking.<subdomain>.workers.dev/health` does not answer.
- [ ] Invocation logs are off (`[observability.logs] invocation_logs = false`): they print full request URLs and the magic/manage links carry tokens in the query.
- [ ] Guest-data purge cron is live: `crons = ["*/5 * * * *"]` is deployed and the purge task appears in the scheduled run (check the Worker's cron triggers and one scheduled invocation in logs).
- [ ] Turnstile: `TURNSTILE_REQUIRED = "true"` with a real site key and `TURNSTILE_SECRET`; a booking without a token is refused.
- [ ] Booking Worker deployed before the swayq PR that binds `InternalApi`.

## Environments

| Env | Worker | Host | D1 | KV | Queue (+ DLQ) |
|---|---|---|---|---|---|
| staging | `swayq-booking-staging` | `book.sway-q.com` | `swayq-booking-staging` | `swayq-booking-cache-staging` | `swayq-booking-tasks-staging` (+ `-dlq`) |
| production | `swayq-booking` | `book.swayq.com` | `swayq-booking` | `swayq-booking-cache` | `swayq-booking-tasks` (+ `-dlq`) |

`LEGAL_OPERATOR = "SwayQ ApS"` (CVR 46300661, per swayq's privacy copy) is
printed on /privacy and /terms.

## Placeholders to fill (from `terraform output` in swayq)

In both `wrangler.<env>.toml`: `database_id` (`booking_d1_database_ids.<env>`),
KV `id` (`booking_kv_cache_ids.<env>`), `TURNSTILE_SITE_KEY`
(`booking_turnstile_site_keys.<env>`). Each is a `REPLACE_WITH_` token; the
deploy workflow fails while any remains.

## Secrets (names only)

GitHub Environment secrets, per environment (`staging`, `production`):

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (used by wrangler)
- Pushed to the Worker with `wrangler secret bulk`: `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY_V1`, `SIGNING_KEY`, `RESEND_API_KEY`,
  `TURNSTILE_SECRET`, `INTERNAL_SERVICE_TOKEN`

`ENCRYPTION_KEY_V1` and `SIGNING_KEY` are base64 of 32 random bytes. Do not
rotate `ENCRYPTION_KEY_V1` without the V2 key flow (refresh tokens are
encrypted with it).

## Env var inventory (vs fork main)

- Set as vars: `BASE_URL`, `BRAND_NAME`, `LEGAL_OPERATOR`, `FROM_EMAIL`,
  `FROM_NAME`, `SUPPORT_EMAIL`, `EMAIL_PROVIDER`, `SIGNUPS` (`@swayq.com`, the
  `@domain` suffix form from `parseSignupPolicy`), `TELEMETRY_ENABLED`.
- `INTERNAL_ALLOWED_DOMAINS` (var) and `INTERNAL_SERVICE_TOKEN` (secret) are
  read by the `InternalApi` named entrypoint (`src/internal/entrypoint.ts`,
  exported from `src/index.ts`; swayq binds it as a service binding). Unset
  token refuses every call.
- `TURNSTILE_REQUIRED`, `TURNSTILE_SITE_KEY` (vars) and `TURNSTILE_SECRET`
  (secret) ARE read, by `src/http/turnstile.ts` (the guest booking form). With
  `TURNSTILE_REQUIRED = "true"` a missing secret or site key fails closed.
- Secrets read: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `ENCRYPTION_KEY_V1`, `SIGNING_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET`,
  `INTERNAL_SERVICE_TOKEN`.
- Deliberately omitted: `DEMO_BOOKING_PATH`, `GA_MEASUREMENT_ID`,
  `ENCRYPTION_KEY_V2`, `EMAIL` (send_email binding; Resend is used),
  `INSIGHTS` / `INSIGHTS_DATASET` / `INSIGHTS_API_TOKEN` (no Analytics Engine),
  `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID` / `ZONE_ANALYTICS_TOKEN`
  (Insights and Admin traffic read-back; optional), `MICROSOFT_CLIENT_ID` /
  `MICROSOFT_CLIENT_SECRET` (Google only for now), `BREVO_API_KEY`.

### Caveats found while writing the configs

- `AVATARS` (R2) is optional in `Env`; without the binding blob storage reads
  as not found and writes throw "avatar storage disabled". Add a bucket in
  swayq Terraform and a binding if avatars or logos are wanted.
- Both queue DLQs have a consumer on the same Worker: `handleQueueBatch` routes
  any queue whose name ends in `-dlq` to the dead-letter handler.

## First deploy order

1. In swayq: `terraform apply` (booking resources from SWA-1290).
2. Copy the booking outputs into both `wrangler.<env>.toml` placeholders and
   commit (PR to this repo).
3. Set the GitHub Environment secrets above for `staging`.
4. Run workflow "SwayQ deploy" with `environment = staging`. It typechecks,
   tests, applies D1 migrations, deploys, pushes secrets and smokes `/health`.
5. Smoke staging by hand (booking page, magic link email, Google connect).
6. Repeat 3 and 4 for `production`.

Swayq's main Worker binds `InternalApi` from `swayq-booking` (service binding).
The booking Worker must be deployed BEFORE swayq PR #2310 merges, otherwise the
swayq deploy fails on the missing target Worker.
