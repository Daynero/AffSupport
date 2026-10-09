# Contract: analytics CLI additions (031)

All commands stay SELECT-only (three layers unchanged). Envelope unchanged: `{ ok, command, generated_at, period, data }`.

## Global options

- `--as-of <iso>`: period end is fixed to this instant and `created_at <= as_of` filters every query. `period.as_of` is echoed. Default: now.
- Every aggregating command adds `data.delivery_lag_ms: { p50, p95, samples }` computed from `created_at - occurred_at` over the period.
- Signals that no known client emits are reported as `{ "status": "unsupported_by_producer" }` instead of `0` (`friction`, `updates`, `onboarding`, `features`, `cohorts`).

## `audit [--period] [--as-of] [--json] [--write]`

Compares `scripts/analytics/coverage-registry.ts` with observed events. Output per data-model.md. `--write` saves `specs/031-platform-autoanalytics/analysis/<as_of date>.json`; without it nothing is written. Findings carry stable ids (hash of capability, status, missing set) so repeated runs do not duplicate.

## `inspect <flow_id|run_id|attempt_id> [--json]`

Every event carrying the id in any correlation column or property, oldest first, with: `stages` reconstructed from the registry (`expected`, `observed`, `missing`), `terminal` (`event`, `outcome`), `last_proven_stage`, `delivery_lag_ms`, and the agent instance/version/platform seen. Properties sanitized with the client allowlist. Unknown id → `{ ok: true, data: { found: false } }`.

## `journey <email>`

Now honours `--period` (default `30d`; `--period all` for the previous behaviour) and sanitizes properties with the client allowlist. Output shape otherwise unchanged.

## `connection` (032)

Unchanged; `delivery_lag_ms` and `--as-of` apply.
