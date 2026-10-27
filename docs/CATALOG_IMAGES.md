# Catalog image publication (045)

The implementation is disabled by default. It publishes public catalog images only; it does not
upload videos, thumbnails or re-stitch screens. A local drop never creates a Drive copy. Original
files remain on the user's computer/Drive. Soty retains metadata and R2 URL mappings, not another
permanent local media library.

An authorized manager explicitly starts **Проаналізувати й завантажити**. Named clothes are matched
by garment/color; ordinary names become ready unclassified images used randomly. Unsupported bytes
are errors independently of classification. The first verified ready dictionary commit completes
the same explicit import action by admitting the team's v2 catalog pool. Dropping files or reading
capabilities never activates it. The mode advisory lock is shared with legacy request admission.

## Isolated runtime configuration

Keep all credentials in ignored runtime secrets. Never commit them or pass them to browsers/logs.
For each separate environment (`production`, `beta`, or `dev`), configure:

| Variable                                                   | Meaning                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CATALOG_IMAGES_ENABLED`                                   | Only exact `true` admits new import work; absent means disabled                 |
| `CATALOG_IMAGES_ENVIRONMENT`                               | One of the three exact environment names                                        |
| `R2_CATALOG_ACCOUNT_ID`                                    | R2 account identifier                                                           |
| `R2_CATALOG_STAGING_BUCKET`                                | `soty-catalog-images-<environment>-staging`, private                            |
| `R2_CATALOG_PUBLIC_BUCKET`                                 | `soty-catalog-images-<environment>-public`, server-write-only                   |
| `R2_CATALOG_PUBLIC_ORIGIN`                                 | Dedicated HTTPS custom media origin, no path/query/credentials                  |
| `R2_CATALOG_TARGET_CONFIRMATION`                           | Exact `<environment>:<accountId>:<stagingBucket>:<publicBucket>:<publicOrigin>` |
| `R2_CATALOG_ACCESS_KEY_ID`, `R2_CATALOG_SECRET_ACCESS_KEY` | Environment-scoped S3 credentials for these two buckets only                    |
| `R2_CATALOG_ZONE_ID`, `R2_CATALOG_PURGE_TOKEN`             | Environment-scoped CDN purge permission for this media zone                     |

The separate metadata configuration `private.catalog_image_config.import_enabled` also defaults to
false. Both runtime and team admission must be enabled through the normal validated release/setup
workflow. The feature adds no production setup command and never provisions buckets automatically.

Supabase uses its normal `SUPABASE_URL`, service role secret, site origin, and the existing
catalog-sync worker secret. `[functions.catalog-images] verify_jwt=false` allows named-secret cron
through the gateway; every user route separately verifies a real user JWT and current permissions.
The worker route accepts only the named secret, without JWT fallback. Local import does not require
Google OAuth. Drive import uses existing scoped credentials, source live ancestry, download/share
capabilities and before/after source identity checks.

## Provider setup required before sandbox acceptance

- Set the default storage class to **R2 Standard** for both environment buckets; verify the actual class in provider acceptance before enable.
- Enable no public access on staging. CORS allows only exact intended browser origins, PUT and the
  explicitly signed Content-Type header. Presigned URLs use the S3 API endpoint, never media origin.
- Attach the isolated public bucket to its dedicated custom media domain, without `r2.dev` access.
  Enable immutable positive caching and disable negative caching for missing candidate paths.
- Configure a Cloudflare response-header transform setting `X-Content-Type-Options: nosniff` on
  this media domain. S3 user metadata cannot supply this response header. Anonymous verification
  checks it; absent/incorrect transform prevents readiness.
- Provision least-privilege zone-transform configuration separately from the runtime purge token.
  Runtime only needs purge permission plus the narrow R2 credentials; it does not edit zone rules.
- Staging lifecycle expiry of one day is a backstop. Application cleanup additionally waits until
  grant expiry plus five minutes and checks active worker ownership. Never apply this lifecycle to
  the public bucket.
- The DB dispatcher derives `/catalog-images/worker` from the existing vaulted catalog-sync URL
  and uses the same vaulted secret. Its periodic job is `soty-catalog-images`; explicit mutation
  and completed work also kick bounded dispatch, so imports need not wait for every cron tick.

SDK imports are pinned to `aws4fetch@1.0.20` and `@supabase/supabase-js@2.110.7`. The function-local lock was generated and the entry point checked with Deno2.5.6. Shared emitted JavaScript advertises its adjacent declaration files using `@ts-self-types`; the shared declaration dependency anchor also makes them reachable to the local Edge CLI's mounted runtime graph. Actual isolated beta adapter/CDN checks passed30/30 and Chrome staging CORS/expiry checks passed9/9 on2026-10-27. Authenticated source-beta application evidence is recorded below. Neither these probes nor source-beta journeys replace hosted gateway/cron/isolate or exact-SHA packaged-release acceptance. Node mocks and a Deno type check alone are not provider evidence. See `specs/045-catalog-r2-images/validation.md` and its sanitized reports.

## Bounds and evidence

One byte-heavy operation per Edge isolate, obtained before DB claim/allocation; busy work requeues
without a retained lease or unbounded queue. DB limits are additionally two worker files/team and
eight globally. A source is at most 50,000,000 bytes and 16,000,000 pixels; the verifier validates
static PNG/JPEG/WebP structure, PNG CRC, metadata orientation and server SHA-256 without decompressing
pixels. It does not prove visual content, brand absence, all codec decoding or Meta ingestion.

A job admits at most 1000 files/5 GB. Drive enumeration uses live provider pages and a persisted BFS
cursor, with explicit `hasMoreSources` and a manager-triggered continuation job. Local manifest and
dictionary pages are bounded. Abandoned local input expires after 24 hours; reads/heartbeats do not
extend that deadline. Already delivered/ready results survive reload. Unknown writes remain unknown.

Presigned URLs are reusable until expiry. Eight **active uploading/unverified entry slots** per team
are released only by trusted verification or a terminal outcome, not a browser delivered hint.
Rate limits are 120 grants/minute/team and actor, recorded across generations. Retired unexpired
grants remain separate exposure until expiry. This feasibility correction permits normal multi-file
imports; eight _all-unexpired_ grants would otherwise admit only eight files per five minutes.
Presigns do not enforce a hard staging byte ceiling. Actual oversized content is never public,
suspends grant issuance for its offending job, and is cleaned up. Residual staging replay/ingress
exposure must be measured in sandbox; it is not presented as a hard quota guarantee.

Public bytes are written from the exact server-verified buffer using create-only PUT. Origin and
anonymous media-domain reads compare all bytes and MIME before the atomic dictionary commit.
Browser grants cannot mutate final keys. A lost PUT response cannot be declared failed by negative
HEAD/GET; same identity remains under bounded positive reconciliation. Orphan cleanup and
adoption/ready/use commits share publication locking/fencing. Explicit revocation/team deletion has
separate durable tombstones surviving cascades; uncertain writes remain an explicit cleanup unknown.
Migration1560 promotes existing future/completed orphan tombstones for those explicit deletion
decisions, resets their bounded attempt budget and fences old receipts, without clearing unknown
writes or shortening existing explicit/team holds. Team deletion retains at least its two-minute
late-write hold. A successful metadata request alone does not prove origin/CDN deletion.

Ready pool removal retains published bytes and historical uses. Uploader/source deletion does not
delete shared team copies. Revocation may remove origin and purge the managed CDN; downloaded or
external cached copies cannot be promised erased. Disabling new imports retains reads, cancellation,
revocation and cleanup while credentials remain configured.

Release acceptance must prove aggregate isolate memory <=192 MB under concurrent worst-case
requests and CPU <=1.5 seconds/invocation, actual R2 CORS/presign/replay/create-only/purge behavior,
old-client compatibility, privacy-safe remote diagnosis and a real external importer. See
`specs/045-catalog-r2-images/quickstart.md`; no such production/provider acceptance is claimed by the
local unit/PGlite checks.

## Signing and local resource reference

Final PUT signing receives headers only, including the server-verified SHA-256 and exact length;
the adapter then attaches a bounded stream of views into the verified buffer. This avoids the
pinned SDK's eager copies of a body-bearing Request while preserving signed conditional creation.
An offline50MB Deno reference improved peak RSS from315MB to167MB and process CPU was463ms.
The reproducible script/result are in `specs/045-catalog-r2-images/benchmark-local.*`. This is not
a hosted aggregate-isolate or actual R2 compatibility proof; those acceptance gates remain open.

## Launch resource compatibility

Apply the complete045 migration chain through1560 before deploying the matching functions and
web. Disabled imports do not make the new functions compatible with a schema lacking their RPCs.
Launch reserves the future catalog child UUID before video restitch, freezes its image selection
under that same identity, then reuses the exact bytes and issued-use receipts across child retries.
Existing accepted generations retain contract1; new generations carry server-owned contract2.
The claim response supplies this version to the server executor. Memoized resources still require
current edit permission, the correct actor, an unarchived Launch and an active parent state.

## Authenticated source-beta evidence and remaining gates

On2026-10-27, an owned loopback-only source beta passed real Auth,16Function boot probes and a
7/7owner/viewer/named-worker gateway matrix. Local scheduled dispatch ran through pg_cron/pg_net.
Actual application PNG/JPEG/WebP import produced3ready copies (2matched,1random); repeat local
and indexed Drive-folder imports reused the same3URLs. Anonymous readback verified exact bytes,
MIME and nosniff. The prompt reached the actual OS clipboard (3895characters), including format,
filename, clothing and brand-exclusion instructions; temporary paste-check content was cleared.

Standalone creation, an explicitly requested background update with a saved12-hour schedule and
Launch generation each produced a real100-product Google Sheet. Independent anonymous CSV
readback verified unique IDs, matched garment/color facts and only the known R2 image URLs.
The update proves the real worker and schedule persistence; a full elapsed12-hour interval was
not observed. The creative video remains in Drive; R2 replaces image hosting only.

The latest full verifier passed14/14gates (8057tests including45explicit skips). The later1560
repair passed8targeted regressions; canonical disposable DB verification passed41SQLfiles and
995assertions plus2realAuth and31native concurrency tests. Its exact migration was applied only
to the owned local beta. Its canonical restart preserved profile/connection identity. The same revoke
intent then passed exact replay, actual scheduled purge and anonymous404; the original three
publications retained their exact bytes and URLs. See the [sanitized beta application result](../specs/045-catalog-r2-images/beta-application-result.json) for scope.

Source beta uses a local project overlay and is not a clean exact-SHA packaged promotion proof.
Hosted secret-only gateway/cron parity, aggregate resource/scale limits, real lost-response/late-write
provider races, packaged macOS/Windows and old clients, elapsed scheduling and an actual external
feed importer remain explicit gates. No Meta ingestion, ad publication or production activation is
claimed. Full evidence and task status are in `specs/045-catalog-r2-images/validation.md`.
