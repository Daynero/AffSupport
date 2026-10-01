# No persistent media on Soty servers

Operator requirement (2026-10-01): keep media on the user's computer or in the
connected Google Drive. Soty stores references, configuration and processing
metadata, not copies of images, audio, video or generated previews.

## Audit findings

| Path                                        | Current destination                                                     | Required change                                            |
| ------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Local stitcher image library                | Local agent `Images` directory                                          | Keep local                                                 |
| Space re-stitching settings                 | Supabase `team-restitch-images`                                         | Replace publication with Drive material references         |
| Provider image/video thumbnails             | Supabase `team-thumbnail-cache` via `drive-transfer` and `preview-warm` | Remove persistent server cache if previews are in scope    |
| Locally generated video poster              | Agent sends image bytes to `drive-transfer`, then thumbnail bucket      | Keep local or deliver to the connected Drive, not Supabase |
| Thumbnail cache copy after Drive operations | `drive-ops` copies objects in thumbnail bucket                          | Remove with server thumbnail cache                         |
| Processed video output                      | Agent uploads to a validated Google resumable upload session            | Keep Drive destination; no Supabase media storage          |

The analytics CLI reports lifecycle counters, not storage bytes. Live storage
inventory previously found 98 re-stitch images and 7,904 thumbnail cache objects.
Existing objects are not deleted as part of investigation.

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

## Compatibility and migration

- Add new source fields/contracts without reinterpreting existing local image IDs
  as Drive material IDs. Old clients must receive an explicit compatible boundary,
  not silently run with empty or incorrect pictures.
- Existing local originals remain intact. Existing shared settings need an explicit
  Drive source selection or an approved transfer destination before cloud copies
  can be retired. Do not erase working settings before replacement is usable.
- Retire upload endpoints and storage writes after all supported execution paths
  use Drive references. Ensure old clients cannot repopulate retired buckets.
- Delete existing server media only after replacement verification and an exact,
  approved cleanup inventory. No bucket-wide deletion during implementation.

## Acceptance checks

- Saving space/member settings writes references only; zero media Storage uploads.
- File and recursive-folder selections work, overlaps do not duplicate images.
- Another member/computer can process via its own local agent and permitted Drive
  downloads without the original owner's local library.
- Renamed/moved/deleted sources and reconnected roots have explicit recovery.
- Local tools keep their images locally and do not gain cloud upload paths.
- Audit all `storage.upload`, object copies, base64 media payloads and warmers.
- If preview caching is removed, browsing and poster/landing fallbacks remain
  usable without any new server object writes.
- Test owner/member permissions, source resolution, interactive/background jobs,
  and upgrade compatibility; follow beta and production release gates.

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
cache recursively. Read-only browsing does not create Drive folders.

This does not yet retire the separate re-stitch image library uploader. That
requires the Drive source-pool replacement described above, including old-client
compatibility. Until that ships, do not claim zero media writes across the whole
product or delete the 98 working re-stitch images.

Transient authenticated proxying of Drive bytes is distinct from
persistent media storage and should not be described as direct client-to-Drive
delivery unless that path is actually implemented.
