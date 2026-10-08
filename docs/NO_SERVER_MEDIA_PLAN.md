# No persistent media on Soty servers

Operator requirement (2026-10-01): keep media on the user's computer or in the
connected Google Drive. Soty stores references, configuration and processing
metadata, not copies of images, audio, video or generated previews.

**Policy stance (2026-10-08).** The published privacy policy
(`apps/web/src/pages/legal-content.ts`, "Media files, thumbnails and image
contents are not uploaded to the server") is the target state, not a
description to soften. Until the re-stitch image bucket is retired and the
legacy objects are gone, the product is behind its own policy; closing that gap
is a release gate for this plan, not a documentation task. The same page also
says re-stitched copies are made "while nobody has Soty open", which is false
today (a member's open tab plus a running agent does the work) and must be
corrected when the background path is decided (see R6).

## Audit findings

Updated 2026-10-08 after commit 30d4d506 and an independent code audit of HEAD
dcb83eb1. "Persistent" means bytes stay on Soty infrastructure after the request.

| Path                                      | Current destination                                                                                                        | Persistent on Soty | Required change                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| Local stitcher image library              | Local agent `Images` directory                                                                                             | no                 | Keep local                                                                     |
| Space re-stitching settings               | Supabase `team-restitch-images` (`apps/web/src/team/restitch/images.ts`)                                                   | **yes**            | Replace publication with Drive material references (below)                     |
| Provider image/video thumbnails           | Drive `Soty Cache/Thumbnails` via `drive-transfer` and `preview-warm` (since 30d4d506)                                     | no                 | Fix the cache defects listed under "Drive cache defects"                       |
| Locally generated video poster            | Agent → `drive-transfer poster_frame` (base64 in JSON) → Drive cache                                                       | no                 | Keep; add a write-capability check before storing                              |
| Thumbnail copy after Drive operations     | `drive-ops copyCachedThumbnail`, Drive → Drive                                                                             | no                 | Add legacy-bucket fallback until the bucket is gone                            |
| Legacy thumbnail objects                  | Supabase `team-thumbnail-cache`, read-only, copied to Drive on access                                                      | **yes** (7,904)    | Block writes at the policy level; inventory; delete after verification         |
| Processed video output                    | Agent → validated Google resumable upload session, direct to Google                                                        | no                 | Keep                                                                           |
| Browser uploads and task attachment drops | `drive-ops /uploads/:id/relay`, edge function → Drive                                                                      | no (transient)     | Keep; document as an allowed transient relay                                   |
| Preview, download, agent process input    | `drive-transfer GET /range`, edge function streams Drive bytes with `no-store`                                             | no (transient)     | Keep; document as an allowed transient relay                                   |
| Landing render segments                   | Agent/browser → `drive-transfer /landing-artifacts` → Drive `Soty Cache/Landing previews`; served back via `/render-range` | no (transient)     | Keep; fix the first-page-only folder lookup (D5)                               |
| Catalog and finance xlsx                  | Built in edge-function memory; catalog goes to Drive beside the video, finance is returned `no-store`                      | no (transient)     | Keep                                                                           |
| ZIP archive inspection in `preview-warm`  | Byte ranges read into memory; only outcome and fingerprint persisted                                                       | no (transient)     | Keep                                                                           |
| Transcript and text file contents         | `team_materials.transcript_text`, up to 1 MB per material                                                                  | **yes (text)**     | Explicitly allowed: derived text for search, not media. State it in the policy |
| Catalog pool images and `share_copy`      | Drive files made "anyone with the link" readers for Meta and recipients                                                    | no                 | Not server storage, but a public exposure; name it in the policy               |

The analytics CLI reports lifecycle counters, not storage bytes. Live storage
inventory previously found 98 re-stitch images and 7,904 thumbnail cache objects.
Existing objects are not deleted as part of investigation.

Verified absent: no bytea or base64 media columns, no Deno KV or `caches.open`,
no service worker, no CDN in front of `/functions/v1`, no media sent to Sentry,
email or AI APIs (transcription and translation run locally with whisper.cpp and
llama.cpp). Only two Storage buckets exist in migrations.

## Re-stitching replacement

1. Separate start and end image source pools. Each accepts individual image
   materials or folders from the connected space, including descendants.
2. Reuse the catalog's `TaskAttachmentPicker`, `FolderPicker`, source list,
   counts and removal interactions. No local-file upload in space settings.
3. Store only material IDs, source kind, slot and existing duration/fit settings.
   Support both shared owner settings and member-specific settings.
4. Resolve source pools inside the current connection/root boundary, reject
   inaccessible, deleted or non-image selections, deduplicate overlapping folders.
5. Retrieve chosen Drive images into the local agent for processing. Never
   publish them to Supabase Storage. Keep immutable local identity/version mapping
   separate from Drive material IDs so stale images are not silently reused.
6. Cover interactive re-stitch delivery and background/catalog re-stitch paths;
   neither may depend on the retired image bucket.
7. Preserve fit modes, start/end toggles and durations. Selecting or saving sources
   must not require a running agent; running local processing still does.

### Requirements added by the 2026-10-08 audit

- **R1 Own form state.** Today the space panel _is_ the local compressor library:
  `RestitchDefaultsSection.tsx` mounts `ImageEmbeddingSection` on the agent and
  reads fit and durations from local settings, so nothing renders without an
  agent and the saved set is never shown back. The panel needs its own state
  hydrated from the saved settings; a member on inherited settings must see the
  owner's pool (names and counts, listed under the member's `view` rights), not
  a lone checkbox.
- **R2 Separate agent cache.** `ensureRestitchImages` imports team images into
  the member's personal start/end library via `addImage`, where they join the
  local compressor's random draws and the stitcher page. Drive-sourced images go
  into a separate agent cache that the library never shows. Decide what happens
  to copies already imported on members' machines (leave, or mark as team-owned
  and hide).
- **R3 Pick before download.** The web currently materialises every id before
  the agent picks one. With folder pools the pick (or a bounded candidate set)
  must happen first, and the contract must say where the pick happens and how
  retries behave (today `Math.random` per run, so a retried catalog job gets a
  different picture). Deduplicate by checksum, not only material id, so a file
  that appears in two sources is not weighted twice.
- **R4 Cache identity.** The agent keys files by UUID, writes with `wx` and
  skips any id that already exists. Local id must derive from material id plus
  md5 (not `drive_version`, which changes on metadata edits) and still satisfy
  the UUID v1–5 regex in `images/store.ts`. Add eviction for images no longer in
  any pool.
- **R5 Selection-time format and size checks.** The catalog "image" category
  includes HEIC, GIF, AVIF, BMP, TIFF and SVG; the agent accepts png, jpg and
  webp only, decides by file-name extension, and rejects over 50 MB after the
  transfer. Filter by mime, extension and `size_bytes` at selection; reject
  animated sources; add EXIF auto-orientation in the stitcher pipeline (phone
  photos from Drive are the common case).
- **R6 Decide whose settings run background jobs.** Catalog re-stitch jobs are
  claimed by any member with `process` and an open tab, and
  `updater-restitch.ts` substitutes the _claimer's_ effective settings, so a
  shared catalog's pictures depend on whose tab won. Decide: owner pool for
  background jobs, member pool only for interactive delivery. A Drive grant
  needs `download`, the bucket needed only `view`; the permission required for
  pool resolution must be chosen and tested for a process-only member. The
  existing catalog-pool pattern is team-wide and needs `manage_metadata`; a
  member-scoped pool table is new work.
- **R7 Old-client boundary, concretely.** Material ids and local asset ids are
  both `uuid` in the same `uuid[]` columns and cannot be told apart: add new
  columns or a table, never reinterpret. The claim request carries only
  `teamId`; add a capability/version so the server can refuse old tabs instead
  of letting them poll, claim and hit the bucket. The new agent capability must
  ship in an agent release first because `packages/shared/src/release.ts` is
  byte-compared with the signed `stable.json`. Remove the hard-coded
  `toolContractVersion: 1` in `CreateProductCatalogDialog.tsx`.
- **R8 Migration of existing rows.** Rows saved before 2026-09-29 reference ids
  that were never published (the bucket did not exist). `sourceUserId` is
  `coalesce(updated_by, owner)` and `updated_by` is nulled on account deletion,
  so the bucket path can point at the wrong user. There is no bucket-object →
  Drive-material map. If the 98 images are transferred, name the destination
  folder (`Soty Cache/Soty` is indexed, which is what makes them selectable) and
  wait for catalog-sync to mint material ids before rewriting settings.
  `delete-account` must also drop the user's bucket folder.
- **R9 Empty or partial pool is a state.** `configured` stays true while every
  source is trashed, missing or out of root; delivery then fails with
  `INVALID_INPUT` and catalog jobs retry forever. Add an explicit resolved-pool
  state, a revalidation trigger on catalog-sync tombstones and reconnects, and
  new error codes in `team_contract_seed` and `apps/web/src/team/errors.ts`.
- **R10 Offline rule.** State whether a cached copy whose md5 matches the last
  resolved pool may be used without a live Drive check. Today an imported id
  works offline; a per-job Drive check would regress that.
- **R11 Close the bucket at the policy level.** The `team_restitch_images_write`
  INSERT policy lets any member with `view` upload through the Storage API from
  any client. Drop it in the same release that stops the web uploader.

## Drive cache defects (shipped in 30d4d506, to fix before claiming done)

- **D1 Browsing creates the cache.** The plan said read-only browsing creates no
  folders. It does: a thumbnail miss calls `store()`, which runs
  `ensureDriveCacheRoot` and creates `Soty Cache`, README, `Thumbnails`,
  `Landing previews` and a shard (`drive-transfer/index.ts:961`). Tests cover
  `read()` only, not the handler. Either accept and document it, or defer
  creation to `preview-warm` and poster/landing writes.
- **D2 Hits cost more than the old misses.** `driveClient()` moved above the
  session-hit branch, so every hit refreshes an OAuth token, runs three
  sequential `findFolderByAppProperty` calls, lists the whole shard and only then
  streams. A 60-tile grid is hundreds of Drive calls on the connector's quota,
  with no throttle, backoff or retry. Fix: cache the access token for its
  lifetime, cache folder ids per team+root, query the shard with
  `appProperties has { key='soty.thumbnail' and value='…' }` instead of listing
  it, and serve hits with `no-store` removed only where safe.
- **D3 Write failures become "no thumbnail".** `store()` throws
  `PERMISSION_DENIED` (read-only root, or `storageQuotaExceeded`, which is
  mapped as permission) or `WRONG_STATE`; neither is in `preview-warm`'s
  `STOP_CODES`, so the whole batch is committed `unavailable/provider_missing`
  and the grid shows "no thumbnail in Drive yet". The on-demand path swallows
  the same errors with no log. Fix: check `canAddChildren` before any cache
  write (the landing path already does), map quota to its own code, treat write
  failures as "serve transiently, do not mark", and log them.
- **D4 Cross-isolate races.** Folder creation is deduplicated by in-memory Maps
  in one isolate; `drive-transfer`, `drive-ops` and `preview-warm` race, and
  `files.list` lags writes, so duplicate `Soty Cache` or shard folders can be
  created. Later lookups take the oldest, the younger one's content is orphaned
  and visible. Thumbnail `store` is check-then-create too. Fix: a DB row per
  team+root holding the cache folder ids (advisory lock on create), and
  tolerate duplicates by merging on read.
- **D5 Nothing is pruned.** Thumbnail paths include the source version, so every
  change adds a file and the old one stays; landing artifacts get a folder per
  material/version/fingerprint/preset; deleted materials keep their thumbnails.
  `landing-previews` folder lookup reads only the first 100 children and
  duplicates after that. No inventory or size metric exists. Fix: prune on
  catalog-sync tombstone and version change, paginate the lookup, and report
  cache object count in readiness.
- **D6 Trash, moves and reconnects.** A trashed `Soty Cache` is silently
  recreated and task-attachment links die with the trash after 30 days. A
  generated folder dragged elsewhere inside the root is silently moved back.
  `task-drop-folder.ts` and `workspace-folder.ts` still search the whole Drive
  without a parent filter (only `restitched-folder.ts` was scoped), so after a
  re-root the old folder is found, `moveGeneratedFolderToCache` throws
  `ROOT_ESCAPE`, and task attachments and re-stitch prepare fail permanently
  and uncaught. Disconnect and team deletion leave the cache untouched. Fix:
  scope both resolvers to the connected root, catch the move, and define the
  disconnect behaviour (leave in place, say so in the README).
- **D7 New hard dependency on quota.** Task attachments now require cache-root
  initialisation, which uploads the README and consumes quota; a full Drive
  breaks attachments although folders alone are free. Fix: make the README
  best-effort.
- **D8 The cache is visible as content.** Only `Thumbnails` and
  `Landing previews` are hidden. `Soty Cache`, `README.md`, `Restitched`,
  `Task attachments` and `Soty` are indexed, searchable, shown in the explorer
  and accept uploads. The `.soty` name rule also hides a user's own `.soty`
  folder. Generated folders are committed with the cache folder as parent before
  catalog-sync has indexed it. Fix: a system-folder flag on materials, explorer
  and search filters, and index the cache root at creation.
- **D9 README.** Ukrainian only while the product has English; recreated whenever
  removed; cataloged as a material. Make it bilingual and exclude it from the
  index.
- **D10 Legacy bucket.** No policy or migration blocks writes; the guard test
  greps for `THUMBNAIL_CACHE_BUCKET` while `drive-transfer` uses the literal
  name; every miss tries a legacy download forever; the legacy read no longer
  normalises `data.type` (regression vs `split(';')[0].trim().toLowerCase()`);
  `copyCachedThumbnail` has no legacy fallback, so copying a material whose
  thumbnail exists only in the bucket loses it. Fix each, then schedule the
  bucket's end date.
- **D11 Untested under `drive.file`.** The beta runs with the restricted `drive`
  scope. Folder discovery via `appProperties`, member access to connector-created
  files and the whole cache flow have never been exercised with `drive.file`,
  which is what production gets (`docs/GOOGLE_OAUTH_VERIFICATION.md`). Walk it
  once with `DRIVE_RESTRICTED_SCOPE_APPROVED=false` before shipping the next
  step.
- **Plausible, not verified:** shared-drive roots (lookup without `driveId` may
  miss folders and duplicate), "Computers" roots (`canAddChildren` false),
  shared-with-me roots (cache files owned by the connector, visible to non-team
  users), and token-endpoint throttling from one refresh per thumbnail.

## Compatibility and migration

- Add new source fields/contracts without reinterpreting existing local image IDs
  as Drive material IDs. Old clients must receive an explicit compatible boundary,
  not silently run with empty or incorrect pictures (R7).
- Existing local originals remain intact. Existing shared settings need an explicit
  Drive source selection or an approved transfer destination before cloud copies
  can be retired. Do not erase working settings before replacement is usable (R8).
- Retire upload endpoints and storage writes after all supported execution paths
  use Drive references. Ensure old clients cannot repopulate retired buckets (R11).
- Delete existing server media only after replacement verification and an exact,
  approved cleanup inventory. No bucket-wide deletion during implementation.

## Acceptance checks

- Saving space/member settings writes references only; zero media Storage uploads,
  and the Storage INSERT policies for both buckets are gone.
- File and recursive-folder selections work, overlaps do not duplicate images,
  and selection rejects unsupported formats and oversized files up front.
- Another member/computer can process via its own local agent and permitted Drive
  downloads without the original owner's local library; a process-only member
  gets a clear error, not a silent empty pool.
- Renamed/moved/deleted sources and reconnected roots have explicit recovery and a
  visible "pool unavailable" state.
- Local tools keep their images locally and do not gain cloud upload paths; team
  images never appear in the member's own library.
- Audit all `storage.upload`, object copies, base64 media payloads and warmers.
- Browsing a grid never marks a thumbnail unavailable because of a cache write
  failure; a read-only or full Drive still shows thumbnails transiently.
- A cache hit costs no token refresh and at most one Drive call.
- Trashing, moving or re-rooting the cache does not break task attachments or
  re-stitch prepare.
- The cache folders are invisible in the explorer and search, and do not accept
  user uploads.
- Walked once under `drive.file` with an account that never consented to `drive`.
- Test owner/member permissions, source resolution, interactive/background jobs,
  and upgrade compatibility; follow beta and production release gates.
- The privacy policy matches the product: no media on the server, re-stitched
  copies made by whichever path R6 decides, transcript text and public catalog
  links named explicitly.

## Confirmed cache boundary (2026-10-01)

The operator explicitly included thumbnails, posters, landing renders and all
automatically created folders. The connected Drive now has one app-marked
`Soty Cache` root, bound to the team and connected root ID, with a Ukrainian
README explaining that results and attachments are not disposable cache.

The backend implementation writes new thumbnail/poster bytes to Drive. Existing
server thumbnails are read-only compatibility inputs: on access they are copied
to Drive, never rewritten in Supabase. Existing objects are not deleted yet.
Landing artifacts use `Soty Cache/Landing previews`; generated Restitched,
task attachment and workspace folders are reparented without changing their IDs.
Preview-only folders are excluded from catalog indexing to prevent caching the
cache recursively. Browsing creates the cache structure on the first thumbnail
miss (D1); the earlier claim that read-only browsing creates nothing was wrong.

This does not yet retire the separate re-stitch image library uploader. That
requires the Drive source-pool replacement described above, including old-client
compatibility. Until that ships, do not claim zero media writes across the whole
product or delete the 98 working re-stitch images.

Transient authenticated proxying of Drive bytes (upload relay, range streaming,
landing segments, xlsx assembly) is distinct from persistent media storage and
is allowed; it should not be described as direct client-to-Drive delivery unless
that path is actually implemented.

## Suggested order

1. D3, D2, D1, D6 — stop the cache from hurting users who already have it.
2. R11 plus D10 policy block — close both buckets to writes.
3. R1–R10 — the re-stitch replacement, as feature 030.
4. D5, D8, D9 — cleanup, visibility, README.
5. Inventory, approved deletion of the 98 and 7,904 objects, policy text update.
