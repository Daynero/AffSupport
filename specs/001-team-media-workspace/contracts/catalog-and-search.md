# Contract: Catalog, Metadata, Search & Synchronization

Covers FR-024 and FR-032…FR-037. Postgres is the searchable catalog; Drive is reconciled
asynchronously but every Soty-originated write updates the catalog immediately after live
Drive verification.

## Catalog/search RPC

### `search_materials(p_team, p_query, p_filters, p_page, p_page_size)`

Returns `{ items, total, activeFilters, facets, catalogFreshness }`.

**Guard**: caller-checked `security definer`. It derives identity from `auth.uid()`, rejects
null/inactive callers, proves `private.can(p_team,'view',auth.uid())`, then applies exact
`team_id=p_team` + `lifecycle='active'` predicates to the item, count, facet, and suggestion
queries. A hidden team/file contributes neither row, count, facet, suggestion nor
timing-dependent “exists” response; owner execution never substitutes for these predicates.

**Input**:

- `p_query?`: normalized text search over name, tags, GEO, offer, language and permitted
  transcript text;
- `p_filters?`: arrays for GEO, language, normalized offer, category and original MIME/type;
  facets combine with AND, values within one facet with OR;
- `unfilled?`: any of `geo|offer|language` to find uncatalogued rows;
- page ≥1 and page size 1–100.

**Normalization/indexes**:

- Unicode NFC + trimmed/casefolded exact facet keys;
- generated `simple`-configuration `tsvector` + GIN for multilingual token search;
- btree `(team_id,lifecycle,<facet>)` indexes and partial missing-facet indexes;
- folders have `category=null` and can be requested separately by `kind`.

**Output**:

- safe item fields: id, parent id, name, kind/category/original type, classification version/
  source, size/modified, GEO/language/offer/tags, transcript ingest/truncation state, preview
  state and derivative/version/source indicator; transcript body is returned only by the
  dedicated preview RPC;
- `total`/facets from visible rows only;
- offer facet values are distinct normalized offers in this team, not a global vocabulary;
- `catalogFreshness` contains connection sync state and `lastSyncedAt` without leaking
  provider details.

**Performance proof**: a deterministic local PostgreSQL 17 fixture has exactly 50,000
visible active rows spanning every category/facet, multilingual/missing metadata, plus
separate hidden-team rows. On dedicated 4 vCPU/8 GiB/SSD, Node 22, no concurrent build/test,
each of three runs performs 20 warmups then 100 searches + 100 filter changes through the
authenticated production RPC wrapper and typed first-page/facet decoder. Overall and both
subgroup p95 must be <2 s; record fixture/query-manifest hashes and p50/p95/p99/max.
`EXPLAIN (ANALYZE, BUFFERS)` is diagnostic only. PGlite is not RLS/performance evidence.

### `get_team_vocab_and_facets(p_team)`

Returns generated ISO GEO + BCP 47 language options and this team's distinct offer/tag
suggestions. Guard `view`. Labels are localized in web; stored/filter values are codes/
normalized text.

### `update_material_metadata(p_team, p_material, p_patch)`

- **Guard**: `manage_metadata`; active material in caller's team.
- Patch may contain only `geo`, `language`, `offer`, `tags`. GEO/language must exist in
  generated lookup rows; offer/tags are NFC/trimmed, bounded and case-insensitively deduped.
- Cannot alter Drive id, parent, lifecycle, search vector, transcript/system columns.
- Updates generated search vector, appends audit if configured, and returns safe snapshot.
- Errors: `PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_INPUT`.

## Canonical classification and transcript ingestion

`packages/shared/src/team/material-category.ts` is the versioned source. Inputs normalize
MIME parameters and extension case; outputs preserve original MIME/extension:

1. folder → `null`; shortcut → `other`;
2. a source-version-bound safe landing-package validation → `landing`;
3. explicit `video/*` → `video`, `image/*` → `image`, HTML/XHTML → `landing`, known archive
   MIME → `archive`, VTT/SubRip or plain text without a conflicting extension → `transcript`;
4. absent/generic/unrecognized MIME falls back to shared video/image, `.html|.htm`,
   `.zip|.rar|.7z|.tar|.tgz|.gz`, or `.txt|.srt|.vtt` extension sets;
5. otherwise → `other`.

A zip is `archive` until the bounded agent scanner validates a single supported landing
entry point for the same Drive version/fingerprint. A later source change clears that proof
and returns it to base classification. Initial/incremental sync, upload/content-edit/new-
version finalize, and reconciliation call this same classifier (or a generated parity-checked
snapshot when the Edge bundle cannot import the workspace package).

For `.txt|.srt|.vtt`, sync/finalize immediately clears stale indexed text when Drive version,
checksum, MIME, or extension changes, then queues a version-bound fetch of at most
`TRANSCRIPT_INDEX_MAX_BYTES` plus the bytes needed to detect truncation/finish a UTF-8 code
point. UTF-8 BOM is accepted; NUL/invalid UTF-8 becomes `invalid_encoding`. TXT is normalized
plain text; SRT/VTT extraction strips recognized header/timing/control lines and markup but
keeps unknown malformed lines as literal text, never HTML. Commit succeeds only while the
expected source identity still matches; otherwise it is discarded/requeued. Tombstone or
root loss removes the body from active search while preserving safe state/provenance.

## Initial and incremental synchronization

### Enqueue triggers

- Confirm/replace root enqueues `initial_scan` after first capturing a Drive start page token.
- One Supabase Cron job (for example every minute) invokes `catalog-sync` with a named secret.
- Soty Drive mutations enqueue targeted reconciliation on uncertain finalize.
- Periodic `reconcile` jobs protect against missed/ambiguous change events.

### Worker contract

`POST /functions/v1/catalog-sync/run` has no user JWT and accepts only the configured named
secret. It leases a bounded number of durable jobs/pages, never a whole 50k scan. Each page:

1. loads credential through a service-only accessor;
2. for initial scan, lists direct children breadth-first and checkpoints folder/page queue;
3. for incremental sync, consumes every `nextPageToken` and stores `newStartPageToken` only
   after the last page;
4. fetches current metadata, validates root ancestry, classifies with the canonical shared
   classifier, and upserts source/classification identity;
5. clears/requeues version-bound transcript ingestion as needed;
6. tombstones known file ids for removed/lost/out-of-root changes and removes searchable
   transcript body;
7. commits checkpoint/lease before taking more work.

My Drive change feeds are account-wide and each item is root-filtered. Shared Drive
connections use their `driveId`, `includeItemsFromAllDrives=true`, and
`supportsAllDrives=true`. Retry 429/5xx with jittered backoff; expired leases can be reclaimed;
permanent failure sets safe connection/sync state and owner guidance.

### Freshness and live UI

`team_operations` and safe catalog-change markers are in `supabase_realtime`. The browser
subscribes with RLS + `team_id`, throttles/refetches authoritative rows after an event, and
does a full refetch after reconnect. No credential, transcript body or large material row is
published. Membership/permission removal closes/recreates the team subscription; protected
actions still authorize independently, so Realtime caching cannot grant an operation.

## Guarantees

- Search/filter/facets/counts do not reveal unauthorized rows.
- External Drive move/rename/trash/lost-access converges without deleting team metadata or
  provenance history.
- A worker timeout resumes from a page checkpoint rather than restarting 50,000 items.
- No catalog row, cached parent or Realtime event authorizes a Drive side effect.
- Sync and every finalize path produce identical category/transcript state for identical
  inputs; stale ingestion or landing-package validation can never commit over a new version.
