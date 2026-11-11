# Catalog video publication to R2 (050)

Disabled by default. An opt-in, per-catalog option copies the catalog's ready video from Google
Drive to Cloudflare R2 and points the catalog's video link at the copy. Everything else — the
library, tasks, previews, re-stitch spare copies — stays on Drive. Catalogs without the option are
untouched byte for byte (SC-001). Spec: `specs/050-catalog-video-r2/`.

## What the option does

- At creation (dialog, catalog menu, Launch catalog configuration) or later in the catalog's
  auto-update settings a member with the catalog settings permission (`manage_metadata`) turns on
  «Копіювати відео в R2». Ticking it plans the copy of the videos the catalog points at; the
  catalog keeps its working Drive link until that copy is ready and verified.
- The link changes by itself (see "How the link changes" below): with a verified `ready` copy for
  the current source version the cell gets the R2 URL; otherwise the catalog keeps the Drive link
  and the copy is queued (idempotent per `(team, source_version)`).
- Only the active version per video source is retained. After the catalog is confirmed on a new
  version, the previous copy loses its last use, becomes `retiring`, and after the grace window
  (6 h by default) is deleted with a CDN purge. A tombstone row survives every cascade (catalog,
  source material, space deletion) until the object is gone.
- Trash, removal from auto-update and pauses keep the copy; only permanent deletion retires it.
  Turning the option off puts the Drive links back the same way and retires the copy once the
  catalog is confirmed on them.

## How the link changes

Since 047 the regular update never writes the video column of a catalog that has a publication
policy (`private.catalog_video_publication_policies`); only a publication job does. The option
therefore works through that one writer (`20261207195000_catalog_video_r2_republish.sql`):

- `private.catalog_video_r2_reconcile(catalog, plan)` compares the link receipts of the last
  published job with what the option asks for. When they disagree and every needed copy is
  `ready` (or the option is off and a receipt is still R2), it queues one more job for the same
  target: a row in `catalog_publication_commands` with payload `origin: video_r2`, the policy
  revision bumped, a `waiting` job. That job resolves each link through
  `_shared/catalog-video-link.ts`, writes the cells with the existing compare-and-swap and
  confirms the uses. It never writes a spreadsheet itself.
- It runs when the option changes (`service_catalog_video_r2_set_preference`, which also plans
  the copies), when a copy becomes `ready` (trigger on `catalog_video_r2_copies`), after any
  publication of that catalog settles (trigger on `catalog_video_publication_jobs`: a re-stitch
  publishes the Drive link of the new video first, the copy follows, then the links are replaced)
  and every minute as a safety net (`pg_cron` job `soty-catalog-video-r2-reconcile`, SQL only,
  never plans a copy).
- It does nothing for a catalog without a preference row, a `held` policy, an unverified legacy
  delivery, while another job of the catalog is active, or when the policy's actor may no longer
  publish. A reconciliation job that did not reach its direction is not repeated for ten minutes.
- A catalog being created never plans copies: the option is written when the catalog is
  registered, and the copies are planned only when its first publication is verified (the
  after-publication trigger plans with `plan=true`). A creation that fails or is abandoned before
  that leaves nothing on R2.
- The worker never uploads a copy nobody waits for (`private.catalog_video_r2_unwanted`, checked
  at every claim): its catalog was trashed or deleted, the option was turned off, or it has no
  catalog and nobody took it within an hour. Such a copy fails as `VIDEO_R2_CANCELED` and its
  tombstone aborts the multipart upload. A ready copy that no catalog confirmed retires after the
  grace window (6 h) and is deleted after another (6 h).
- A catalog deleted for good lets go of its copies: every sweep (5 min) releases the uses of
  catalogs whose sheet is `missing` with reason `removed` or has been `trashed` for more than
  30 days (Drive's own trash period); a copy no other catalog uses is deleted in the same sweep,
  without the 6 h grace (nothing reads that sheet again and nothing can restore it). A catalog in the trash, or moved out of the watched
  folder (`out_of_root`), keeps its copy: its sheet still points at it and a restore must work.
- A catalog without a policy (created before 047) keeps the whole-file path: ticking the option
  plans the copy of its current video, and the next update writes the R2 link once the copy is
  ready (`resolveVideoLink` in `catalog-updater/worker.ts`).

Measured on beta (2026-11-10, 48 MB video, 100 products): ticked → copy ready in about two
minutes → all 100 cells on the R2 URL about a minute later; unticked → all cells back on the
Drive link within a minute, copy `retiring` with the 6 h grace.

## Isolated runtime configuration

Keep all credentials in ignored runtime secrets. Never commit them or pass them to browsers/logs.
For each environment (`production`, `beta`, `dev`), alongside the 045 variables, configure:

| Variable                                                               | Meaning                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CATALOG_VIDEOS_ENABLED`                                               | Only exact `true` admits new copy work; absent means disabled                   |
| `CATALOG_IMAGES_ENVIRONMENT`                                           | Shared with 045: one of the three exact environment names                       |
| `R2_CATALOG_ACCOUNT_ID`                                                | Shared with 045: R2 account identifier                                          |
| `R2_CATALOG_VIDEO_STAGING_BUCKET`                                      | `soty-catalog-videos-<environment>-staging`, private, multipart only            |
| `R2_CATALOG_VIDEO_PUBLIC_BUCKET`                                       | `soty-catalog-videos-<environment>-public`, server-write-only                   |
| `R2_CATALOG_VIDEO_PUBLIC_ORIGIN`                                       | Dedicated HTTPS custom video origin, no path/query/credentials                  |
| `R2_CATALOG_VIDEO_TARGET_CONFIRMATION`                                 | Exact `<environment>:<accountId>:<stagingBucket>:<publicBucket>:<publicOrigin>` |
| `R2_CATALOG_VIDEO_ACCESS_KEY_ID`, `R2_CATALOG_VIDEO_SECRET_ACCESS_KEY` | Environment-scoped S3 credentials for these two video buckets only              |
| `R2_CATALOG_ZONE_ID`, `R2_CATALOG_PURGE_TOKEN`                         | Shared with 045: CDN purge permission for the media zone                        |
| `CATALOG_VIDEOS_PART_VERIFICATION`                                     | `readback` (default). `provider_checksum` is refused by R2 today (see below)    |

`readCatalogVideoR2Config` refuses `.r2.dev` and `*.r2.cloudflarestorage.com` origins and any
mismatch of the target confirmation. The database configuration
`private.catalog_video_r2_config` (`enabled`, `policy_confirmed_at`, `part_bytes`,
`grace_interval`, `team_quota_bytes`, `max_object_bytes`) also starts disabled. Both the runtime
and the database gate must be on, and the policy confirmed, before the checkbox is shown.

Supabase uses its normal `SUPABASE_URL`, service role secret, site origin, and the existing
catalog-sync worker secret (`CATALOG_SYNC_SECRET` in the function environment, vault
`wishly_catalog_sync_secret` for `pg_cron`). `[functions.catalog-video-r2] verify_jwt=false`
lets the named-secret cron through the gateway; every user route verifies a real user JWT and
current permissions; the worker route accepts only the named secret.

## Buckets, CORS, Range, caching

- Public objects: `https://<videoOrigin>/v/<32 hex>.mp4`, `content-type: video/mp4`,
  `cache-control: public, max-age=31536000, immutable`, `x-content-type-options: nosniff`.
  Keys are random and opaque; nothing about the tenant or the file is in the URL.
- The public origin must answer anonymous `GET` and `HEAD` with `accept-ranges: bytes` and honour
  `Range` requests: advertising platforms and players fetch by range.
- No browser ever writes to either bucket; CORS on the buckets is unnecessary. The hosted site's
  CSP does not need the video origin (links are opened by third parties, not embedded).
- Cloudflare zone rules per video hostname, the same pair the image hostname has: a Response
  Header Transform rule setting `X-Content-Type-Options: nosniff` (object metadata cannot supply
  it; without it the worker refuses the copy) and a Cache Rule "eligible for cache, use
  cache-control if present, bypass if not" so a 404 is never cached for hours. The purge token
  (`R2_CATALOG_PURGE_TOKEN`, shared with images) needs Zone → Cache Purge on the zone and must
  not expire: the beta token created on 2026-10-27 had a one-day lifetime and silently broke
  purges until it was replaced on 2026-11-10.
- Staging bucket holds only in-progress multipart uploads; abandoned uploads are aborted by the
  sweep and bucket lifecycle rules should also expire incomplete multipart uploads after 7 days.

## Copying

- Transport: Drive `files.get?alt=media` with `Range` (`GoogleDriveClient.fetchFileRange`) →
  edge function → R2 `UploadPart`, 16 MiB parts by default (5–64 MiB configurable), at most
  10 000 parts, within a 60 s invocation budget under a lease; the next claim resumes with the
  first unfinished part.
- Verification before the catalog may point at the copy: size equals the Drive size; every part's
  SHA-256 is confirmed by `readback` of the part from staging (R2 answers `501 NotImplemented` to
  `x-amz-checksum-sha256` on `UploadPart`, measured 2026-11-10, so `provider_checksum` stays a
  dormant strategy that fails closed with `VIDEO_R2_NOT_CONFIGURED`);
  the public copy answers `HEAD` with the expected length and type; Range probes at the start, the
  end and random part boundaries match Drive; when the whole file fit into one invocation the full
  MD5 is compared with Drive's `md5Checksum` (`full_hash_verified`). When it did not, the limit of
  proof is explicit in diagnostics, never hidden.
- Source changed on Drive during the copy → `SOURCE_CHANGED`, the copy fails, the next update
  retries against the new version.

## Quotas and cost

- `team_quota_bytes` (5 GB by default, owner decision 2026-11-11) bounds `uploading|verifying|ready|retiring` bytes per
  space; exceeding it refuses the copy with `VIDEO_R2_QUOTA_EXCEEDED` and keeps the Drive link.
- The space tariff page shows used bytes and a monthly estimate derived from the 045 cost model
  with 100 MB videos; it is an estimate, never an invoice.

## Background work

- `private.invoke_catalog_video_r2_worker(route)` reads the vault entries
  `wishly_catalog_sync_url` / `wishly_catalog_sync_secret`, derives
  `/functions/v1/catalog-video-r2/worker`, and posts `{"route": ...}` with `x-catalog-sync-secret`.
- `cron.schedule('soty-catalog-video-r2-claim', '30 seconds', …)` copies and verifies;
  `cron.schedule('soty-catalog-video-r2-sweep', '*/5 * * * *', …)` retires orphans, deletes
  retired objects, purges the CDN and aborts orphaned multipart uploads.

## Enabling (owner, in order)

1. Deploy the migration and the edge functions dark through the release backend plan
   (`npm run release:backend-plan` → `npm run release:backend-apply`); never by hand.
2. Full release (shared types) after 1.4.0; the checkbox stays hidden by the availability gate.
3. Publish the privacy policy / terms text (`apps/web/src/pages/legal-content.ts`).
4. Confirm in the database: `update private.catalog_video_r2_config set enabled=true,
policy_confirmed_at=now();` (through the release DB connection, with a receipt), set
   `CATALOG_VIDEOS_ENABLED=true` in the function environment, then enable for the owner's space
   first and watch `npm run analytics -- catalog-video-r2 <team-id>`.

## Diagnostics

`npm run analytics -- catalog-video-r2 <team-id|catalog-material-id|copy-id>` reads the immutable
journal (`analytics_catalog_video_r2_journal`): stages from `configured` through `planned`,
`uploading`, `verifying`, `ready`, `confirmed`, `retiring`, `deleted`, `failed`, `purged`; the
closed reason codes; `link_kind`; `part_verification`; `full_hash_verified`. A public GET proves
reachability at the point of check, not acceptance by an external platform; billing without
provider proof is an estimate.
