# Data model

## CatalogUpdateProfile

One per live catalog. Fields: `catalog_id`, `team_id`, `interval`, `next_run_at`, `random_link_variation`, `refresh_images`, `refresh_texts`, `grow_products`, `restitch`, `version`, `updated_at`, `updated_by`. Five booleans are explicit after migration. `interval=null` means no future scheduled run. Update uses expected `version` and rejects stale writes. Shared template seeds only new profiles.

## CatalogUpdateAttempt

Fields: `attempt_id`, `flow_id`, `catalog_id`, `trigger` (`schedule|manual|retry`), `profile_snapshot`, `profile_version`, `started_at`, `ended_at`, `stage`, `result` (`running|success|partial|failed|cancelled|unknown`), `failure_code`, `delivery_verified_at`, `source_attempt_id`, `idempotency_key`. Immutable result history, at least ten recent attempts visible. A retry is a new attempt using current profile; `source_attempt_id` links it to the failure.

## CatalogStatusSummary

Derived from profile and attempts: last verified success, last attempt, active attempt, next run, stale snapshot time. Last success is never replaced by a later failure. A successful write with missing delivery proof is `unknown`; a confirmed table update without fresh video is `partial`.

## Transitions

`scheduled → claimed → preparing → refreshing → building → uploading → verifying → finalizing → success|partial`; failures can occur at any stage and lead to retry or terminal failure. Cancellation of active attempt is distinct from `interval → null`. Profile edits during an attempt affect the next claim only. Manual attempts leave `next_run_at` unchanged.
