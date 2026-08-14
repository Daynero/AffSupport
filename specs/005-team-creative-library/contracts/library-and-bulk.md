# Contract: Creative Library, Bulk Upload & Lightweight Enrichment

## Catalog projection

`search_materials` and folder listings add safe placement/enrichment fields: Stage, normalized
structural values, placement state, language decision source, and independent thumbnail/
preview states. Every item/count/facet remains exact-team and `view` filtered. A material is
visible while enrichment is pending; no pending marker looks ready.

## Start a bulk upload

`POST /functions/v1/library-ops/batches/start`

Body: `{ teamId, stage, offer, geo, languageMode, language?, typeHint?, items[] }`, where each
item has a client-generated opaque key, name, MIME and non-negative size.

- Guard: current `upload`; active connected root; at least one item; accepts at least 100
  items while enforcing a documented request-body bound.
- Manual language requires a controlled value and wins permanently until the user changes
  it. Auto uses explicit `unknown` until local detection commits.
- Creates/reuses one batch and one item operation per client key. Returns per-item resumable
  session data; session URIs are memory-only and redacted.
- A failed item does not roll back completed items. Batch state is derived from item states.

Finalize reuses the existing upload verification/classifier path, applies shared metadata,
commits the asset to the requested stage, and queues only lightweight version-bound
enrichment. It returns the material independently as soon as that item is ready.

## Canonical placement and structural move

`POST /functions/v1/library-ops/placement/plan` validates a material selection, requested
Stage/Offer/Language/Type, permission (`edit` + metadata permission where fields change),
normalized collisions, and the exact folder plan without provider mutation.

`POST /functions/v1/library-ops/placement/commit` takes the confirmed plan + idempotency key:

1. lock/ensure one verified canonical folder at each of the four levels;
2. resolve the source and current sidecar group;
3. prove live root ancestry and move capabilities for every member/destination;
4. move and post-verify the group through one intent;
5. commit structural metadata and state only after convergence.

Finds↔Library is this same contract with only Stage changed. External provider partial
failure returns `GROUP_RECONCILING` with an operation id and safe retryability; it never
returns a ready target Stage prematurely.

## Language enrichment

The local agent receives a scoped job with bounded source transfer and no provider token.

- landing: inspect only readable, path-confined document text;
- video: sample roughly 5–8 seconds, then one later bounded sample if the first lacks speech;
- output: controlled language + confidence or `unknown`.

Commit requires the same material source version, `languageMode='auto'`, and unchanged
decision revision. A manual value cancels/fences the job; late auto commit returns
`STALE_RESULT` without changing metadata.

## Thumbnail/preview enrichment

Images reuse authorized media preview. Landing preview reuses feature 004 cached render.
Video lightweight state records a 1,000 ms target; the browser tile becomes ready only after
the media element seeks to 1.0 s, or its last available instant if shorter. Heavy
transcription/translation/optimization is never enqueued by upload.

## Errors

`INVALID_INPUT`, `PERMISSION_DENIED`, `NOT_A_MEMBER`, `NAME_CONFLICT`, `ROOT_ESCAPE`,
`DRIVE_UNAVAILABLE`, `NEEDS_REAUTH`, `RATE_LIMITED`, `SOURCE_CHANGED`, `STALE_RESULT`,
`GROUP_RECONCILING`, `TOO_LARGE`, and existing resumable transfer errors.
