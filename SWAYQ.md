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

<!-- Integrator fills this section. -->

## Environments

| Env | Worker | Host | D1 | KV | Queue (+ DLQ) |
|---|---|---|---|---|---|
| staging | `swayq-booking-staging` | `book.sway-q.com` | `swayq-booking-staging` | `swayq-booking-cache-staging` | `swayq-booking-tasks-staging` (+ `-dlq`) |
| production | `swayq-booking` | `book.swayq.com` | `swayq-booking` | `swayq-booking-cache` | `swayq-booking-tasks` (+ `-dlq`) |

`LEGAL_OPERATOR = "SwayQ ApS"` is a guess: confirm the legal entity name before
production (it is printed on /privacy and /terms).

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

## Env var inventory (vs `Env` in `src/index.ts` at the pin)

- Set as vars: `BASE_URL`, `BRAND_NAME`, `LEGAL_OPERATOR`, `FROM_EMAIL`,
  `FROM_NAME`, `SUPPORT_EMAIL`, `EMAIL_PROVIDER`, `SIGNUPS` (`@swayq.com`, the
  `@domain` suffix form from `parseSignupPolicy`), `TELEMETRY_ENABLED`.
- Set as vars, NOT read by the upstream pin (added by SwayQ source changes in
  parallel work; harmless until then): `INTERNAL_ALLOWED_DOMAINS`,
  `TURNSTILE_REQUIRED`, `TURNSTILE_SITE_KEY`.
- Secrets read by upstream: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `ENCRYPTION_KEY_V1`, `SIGNING_KEY`, `RESEND_API_KEY`.
- Secrets not read by the pin, for the SwayQ source changes: `TURNSTILE_SECRET`,
  `INTERNAL_SERVICE_TOKEN`.
- Deliberately omitted: `DEMO_BOOKING_PATH`, `GA_MEASUREMENT_ID`,
  `ENCRYPTION_KEY_V2`, `EMAIL` (send_email binding; Resend is used),
  `INSIGHTS` / `INSIGHTS_DATASET` / `INSIGHTS_API_TOKEN` (no Analytics Engine),
  `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID` / `ZONE_ANALYTICS_TOKEN`
  (Insights and Admin traffic read-back; optional), `MICROSOFT_CLIENT_ID` /
  `MICROSOFT_CLIENT_SECRET` (Google only for now), `BREVO_API_KEY`.

### Caveats found while writing the configs

- `AVATARS` (R2) is typed required (`Env.AVATARS: R2Bucket`) and
  `createR2BlobStorage(env.AVATARS)` is built at startup, but the bucket is only
  touched on avatar/logo upload and serve. Without the binding the Worker boots,
  and those paths throw at runtime. Add a bucket in swayq Terraform and a binding
  if avatars are wanted.
- The app has no DLQ-specific handler: `queue()` runs the same
  `handleQueueBatch` for every batch. A consumer attached to the DLQ would
  re-run dead messages as tasks, so no DLQ consumer is configured. Dead letters
  accumulate in `...-dlq` for inspection.

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
