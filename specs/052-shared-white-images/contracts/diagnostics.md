# Contract: read-only global-images status and diagnosis

## CLI surface

Extend existing analytics CLI, dedicated SELECT-only role, forced read-only transactions, SQL guard and bound parameters unchanged:

```bash
npm run analytics -- global-images --json
npm run analytics -- global-images --image <uuid> --json
npm run analytics -- global-images --at-least 5000 --sort uses --limit 50 --json
npm run analytics -- global-images --cursor <opaque-cursor> --json
npm run analytics -- global-images --cleanup --json
```

One stable envelope `{ ok, command, generated_at, period, data }`; failures preserve existing error form. Default report is current all-time operational observation; period/as-of restricts immutable evidence, not a fabricated historical value of mutable counters. For historical unavailable counters return explicit historical_unknown. No reporting command provisions/activates/cleans anything or uses service-role credentials.

## Data fields

Summary: scope/environment/policy epoch, `observed_since`, `fresh_through`, baseline quality, total/ready/not_ready/unknown images; `confirmed_uses_total` decimal string, `images_at_least_5000`, `pending_operations`, `issued_slots_total` decimal string; threshold5000 no stop.

Image: stable image_id, controlled permanent public_preview_url, MIME/classification metadata, readiness/proof revision/freshness; `confirmed_uses_total`, `threshold=5000`, `threshold_status=below|reached`; `issued_slots_total`, `current_generation`, `issued_in_generation<=200`, `confirmed_in_generation<=issued`, `next_aliases_ready`, unknown operation count, last confirmed use time nullable. Public URL appears only in owner status projection; evidence/journal strips it.

Cleanup: T0/delete_after, manifest counts, retained/due/pending/deleted/unknown/external_untouched, overdue count/oldest due, remaining legacy catalogs with denominator/coverage, last proven stage/code. Unknown ownership and source/provider proof gaps remain explicit.

List: default50/max100; sort image_id ASC or confirmed_uses DESC,image_id ASC; cursor carries schema/policy/environment/scope/filter/sort, last tuple, observation_at (TTL60s) and source_revision. Each invocation uses one repeatable-read snapshot for summary+page. Revision is a read-only SHA256 fingerprint of all ordered status-visible image tuples/counters/proofs/alias states/config fields, not a writable global row or max(journal_seq). Readiness evaluates at cursor observation_at. Changed revision/expired cursor -> explicit cursor_stale. At most one restart, then explicit partial/truncated scope; no infinite retries or silent joining different snapshots. Cleanup summary has an independent observation, no image cursor dependency. No analytics writes to store report snapshots.

## Diagnostics integration

Extend existing `catalog-images` historical diagnosis and `investigate`, `inspect`, `audit`; do not replace or reshape historical commands. Register capabilities global import/allocation/update/cutover/retirement, expected ordered stages, owner/source/version/platform support. Old pool/prompt/import capabilities acquire retired-since epoch/build; absence after T0 is not a fresh failure or evidence of zero activity.

Critical unsampled signals use existing typed operation seams and sanitized immutable server journal. Include indirect flow/operation/attempt/catalog/image/alias IDs, policy/config revision, normalized code, occurrence/receipt time, bounded count/time/size buckets. Exclude content, URLs/tokens, source names/paths, provider payloads, raw platform logs and secrets. Exact counters come from authoritative receipts/aggregates, not sampled events. Client analytics disabled does not change product state.

Diagnosis distinguishes fact/hypothesis/insufficient with evidence refs, last proven stage, actual delivered result, retryability and safe next step. Missing/delayed/expired evidence remains unknown. Delivery lag p50/p95, truncation, missing joins, scope/timezone and cohort build support explicit. Public GET ≠ Meta import ≠ ad impression;5000 counts confirmed catalog+image pairs,200 counts issued bindings.

## Coverage acceptance

Run synthetic complete/failure/partial/rejected/cancel/interrupted/recovered/unknown journeys through producer→sanitizer→stored evidence/projection→CLI result. Include typed-code/code-map parity, delayed/missing terminal and current-vs-as-of, 199/200/201 issued with failures,4999/5000/5001 confirmed, old false flag, T0/day30 cleanup and cross-team privacy. Read-only query failure must not become zero. No feature readiness claim while a critical path lacks end-to-end evidence.
