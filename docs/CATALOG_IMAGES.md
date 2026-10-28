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

## Lossless canonical publication

Both local and Drive imports normalize images on the server before final public publication.
Local originals first pass through private R2 staging; this is not a promise to optimize before
any upload. Source bytes, size and available SHA-256 remain separate from the canonical output
size/hash/MIME and pinned optimization version. Reconciliation reads the already reserved output;
it does not create a different image or rerun normalization under a new identity. Existing ready
URLs and their issued bytes are not rewritten.

| Input | Processing and bounds                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JPEG  | Source up to 50,000,000 bytes; up to 4,000,000 pixels. Ordinary 8-bit grayscale/RGB baseline or progressive JPEG. Remove comments without re-encoding coefficients, quantizers or image scans; retain rendering metadata. Strict decode validation has a 64 MiB allocation budget and rejects unsupported or corrupt streams.                                                  |
| PNG   | Source up to 50,000,000 bytes and 16,000,000 pixels. Validate strict chunk/palette/transparency structure, CRC, zlib and every scanline, including Adam7 and 16-bit samples. Losslessly recompress filtered scanlines when smaller; discard only the documented text/time metadata and retain color/alpha/rendering information. No complete raster is required for this path. |
| WebP  | Source up to 8,000,000 bytes and 4,000,000 pixels. Decode the static image and write PNG preserving decoded RGBA pixels and supported ICC/EXIF rendering metadata. PNG can be larger than its WebP source.                                                                                                                                                                     |

Every new normalized public result is actual JPEG or PNG, at least 500 pixels on each side and at most
8,000,000 bytes. No resizing, quality reduction, chroma subsampling change or alpha flattening is
used to force a file under that limit. Lossless optimization cannot always shrink an image:
oversized results fail with an actionable error instead of silently losing quality. A smaller
PNG source can be retained if recompression would grow it. Pathological containers are bounded
before constructing per-chunk/marker objects. Animation and unsupported orientation remain errors.
These checks do not establish visual clothing/brand truth or universal decoder/importer acceptance.

The copyable generation prompt is now `catalog-clothing-v2`; its filename vocabulary remains
`catalog-clothing-v1`. It requests 100 separate unbranded clothing images by default, recommends
1024×1024, states the input geometry/output-byte limits and warns that lossless processing cannot
guarantee a smaller file. The actual file extension must match its bytes.

## Bounds and evidence

One byte-heavy operation per Edge isolate, obtained before DB claim/allocation; busy work requeues
without a retained lease or unbounded queue. DB limits are additionally two worker files/team and
eight globally. The format-specific limits and decode/streaming behavior are listed above.
Source/canonical SHA-256 and exact public readback establish byte identity; they do not prove
visual content, brand absence or Meta ingestion.

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

Public bytes are written from the exact normalized and server-verified buffer using create-only PUT. Origin and
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

## Owner-account quota and library management

The current workspace owner's account has one shared physical-publication budget across all its
workspaces: **100,000,000 bytes (100 MB = 0.1 GB) and 500 unique stored objects**. `usedBytes` is the complete
charged total, including reservations, pending cleanup and retained copies; the displayed subsets
must not be added to it again. `reservedBytes` covers processing candidates, `libraryBytes` active
ready copies, `pendingDeletionBytes` explicit/team cleanup, and `retainedBytes` the other charged
copies outside the active pool. This workspace and other owned workspaces have separate numeric
subtotals. Both limits apply independently: approximately 200 KB per image would fill the byte
budget at 500 images, but larger images reach it sooner. The 200 KB target is a recommendation
when quality permits, not a reason to resize or introduce lossy conversion. Unknown/unavailable usage is not displayed as zero; a failed refresh explicitly marks
the previous successful value as stale.

Same-team canonical dedup reuses the existing object without a second charge. The same bytes in
different workspaces remain separate scoped publications and are charged for their physical copies.
At capacity, reuse is still possible; new unique objects require available capacity. A new candidate
reserves its canonical bytes atomically against the shared account budget, including concurrent
imports in different workspaces. Retained copies and uncertain writes stay charged. Owner transfer
reattributes the team's existing charges to its new owner; an already over-limit recipient retains
existing data and can reuse copies, but cannot grow the budget until capacity is available.

**Remove from pool** stops future selection while preserving links, historical catalogs and storage
charges. The manager's stored-picture library includes inactive copies and shows bounded pages with
lazy thumbnails only while expanded. **Delete stored picture** explicitly revokes the publication;
its confirmation warns that existing catalogs will lose that image. Pending/unknown cleanup has no
second delete action. Quota is credited only after authoritative known deletion: completed explicit/
team cleanup, or completed orphan cleanup that actually revoked the candidate. An orphan marked
complete merely because its ready copy was retained does not free capacity. Unknown deletion stays
charged even after one observed delete, because a late provider write may still exist. Durable owner/
size attribution survives team deletion until cleanup can be reconciled.

The existing single team Realtime channel subscribes to content-free storage revision signals.
Account changes fan out invalidation to owned workspaces; clients reread authoritative usage and
library state through their existing refresh flow. No new polling or second global channel is added.
Viewers may read aggregate storage; only managers can list/manage library identities.

Release acceptance must prove aggregate isolate memory <=192 MB under concurrent worst-case
requests and CPU <=1.5 seconds/invocation, actual R2 CORS/presign/replay/create-only/purge behavior,
old-client compatibility, privacy-safe remote diagnosis and a real external importer. See
`specs/045-catalog-r2-images/quickstart.md`; no such production/provider acceptance is claimed by the
local unit/PGlite checks.

## Signing and local resource reference

Final PUT signing receives headers only, including the server-verified SHA-256 and exact length;
the adapter then attaches a bounded stream of views into the verified buffer. This avoids the
pinned SDK's eager copies of a body-bearing Request while preserving signed conditional creation.
The earlier offline50MB signing-only Deno reference improved peak RSS from315MB to167MB and process CPU was463ms.
The reproducible script/result are in `specs/045-catalog-r2-images/benchmark-local.*`. This is not
a hosted aggregate-isolate or actual R2 compatibility proof; those acceptance gates remain open.
That reference predates normalization and cannot establish its resource budget. The current offline
mixed-codec run reported peak RSS of about 266 MB and physical footprint of about 87 MB. Those are different process
metrics; the smaller footprint must not replace RSS to declare a pass. The formal **aggregate 192 MB
memory / 1.5 CPU-second gate remains OPEN** for mixed JPEG/PNG/WebP work, concurrent worst cases and
the actual hosted runtime. The current offline result is not a production resource pass.

## Launch resource compatibility

Apply the complete 045 migration chain through 1590 before deploying the matching functions and
web. Disabled imports do not make the new functions compatible with a schema lacking their RPCs.
Launch reserves the future catalog child UUID before video restitch, freezes its image selection
under that same identity, then reuses the exact bytes and issued-use receipts across child retries.
Existing accepted generations retain contract1; new generations carry server-owned contract2.
The claim response supplies this version to the server executor. Memoized resources still require
current edit permission, the correct actor, an unarchived Launch and an active parent state.

## Historical source-beta baseline and remaining gates

The following application/provider evidence predates migrations 1570–1590, canonical normalization,
account quota and prompt v2. It remains evidence for its recorded baseline, not live acceptance of
the new follow-up. Current targeted tests and pending gates are recorded in
`specs/045-catalog-r2-images/validation.md`.

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

Before the normalization/quota follow-up, the full verifier passed14/14gates (8057tests including45explicit skips). The later1560
repair passed8targeted regressions; canonical disposable DB verification passed41SQLfiles and
995assertions plus2realAuth and31native concurrency tests. Its exact migration was applied only
to the owned local beta. Its canonical restart preserved profile/connection identity. The same revoke
intent then passed exact replay, actual scheduled purge and anonymous404; the original three
publications retained their exact bytes and URLs. See the [sanitized beta application result](../specs/045-catalog-r2-images/beta-application-result.json) for scope.

Source beta uses a local project overlay and is not a clean exact-SHA packaged promotion proof.
Hosted secret-only gateway/cron parity, aggregate resource/scale limits, real lost-response/late-write
provider races, packaged macOS/Windows and old clients, elapsed scheduling and an actual external
feed importer remain explicit gates. No Meta ingestion, ad publication or production activation is
claimed. T055's actual external/Meta feed-import acceptance remains explicit and open; JPEG/PNG
output and anonymous GET alone cannot close it. Full evidence and task status are in
`specs/045-catalog-r2-images/validation.md`.
