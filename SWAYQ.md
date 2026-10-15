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
The integrator appends later units.

- Docs/migrations: `docs/internal-api.md`, `migrations/0018_calendar_sync_state.sql`
- Adapters: `src/adapters/{calendar-sync-alerts,calendar-sync-errors,calendar-sync-redrive,coordinator,providers,scheduled}.ts`, `src/adapters/d1/{repositories,schema}.ts`, `src/adapters/google/{get-event,internal-meetings,provider}.ts`, `src/adapters/microsoft/{get-event,provider}.ts`, `src/adapters/queue/consumer.ts`
- Core: `src/core/domain/{booking-service,calendar-sync,types}.ts`, `src/engine.ts`, `src/ports.ts`, `src/testing/fakes.ts`
- HTTP: `src/http/{router,calendar-connect,dashboard-routes}.ts`, `src/http/api/rest.ts`, `src/http/mcp/server.ts`, `src/index.ts`
- Internal API (new): `src/internal/{contract,entrypoint,schemas,service,token}.ts`
- Tests: `test/core/{calendar-parsing,calendar-sync-dispatch,calendar-sync-durability,internal-api}.test.ts`, `test/workers/{calendar-fail-closed,calendar-sync-state,internal-entrypoint,no-avatars-binding}.test.ts`, `test/workers/env.d.ts`
- Template/ignore: `wrangler.toml` (DLQ consumer block), `.gitignore` (tracks the two SwayQ configs)
- Avatars: `src/adapters/storage/r2-blob.ts` (null storage when no AVATARS binding), `Env.AVATARS` now optional

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
  (secret) are set but NOT yet read by the code on fork main; they take effect
  when the Turnstile source change lands.
- Secrets read: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `ENCRYPTION_KEY_V1`, `SIGNING_KEY`, `RESEND_API_KEY`, `INTERNAL_SERVICE_TOKEN`.
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
