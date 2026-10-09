# Contract: analytics events (031)

## Guard contract

`apps/web/src/analytics/events.ts` exports:

```ts
export const ANALYTICS_PROPERTY_KEYS: readonly string[];
export const ANALYTICS_PROPERTY_ENUMS: Readonly<Record<string, readonly string[]>>;
export const ANALYTICS_BOOLEAN_KEYS: readonly string[];
export const ANALYTICS_NUMERIC_RANGES: Readonly<Record<string, [number, number]>>;
```

`tests/analytics-guard-contract.test.ts` loads the latest migration defining `analytics_properties_are_safe_v2` into PGlite and asserts, for every key: an object with that key and a representative value is accepted; for every enum: each value accepted and `__bad__` rejected; for every boolean: `true` accepted, `'true'` rejected; for every range: both bounds accepted, out of range rejected. The team sanitizer (`packages/shared/src/team/analytics.ts`) is checked the same way.

## New events

| Event | Required properties | Correlation |
| --- | --- | --- |
| `tool_ready` | `tool_identifier`, `outcome`, `duration_ms`, `error_stage?`, `error_code?` | none |
| `error_occurred` (all tools) | `tool_identifier`, `error_stage`, `error_code`, `error_fingerprint`, `retryable?` | `flow_id` or `run_id` |
| `analytics_delivery_report` | `rejected_count`, `evicted_count`, `expired_count`, `rejected_events?`, `evicted_events?`, `report_window_ms` | none |
| `stitch_completed` / `stitch_failed` | `tool_identifier`, `file_count` | `run_id` |
| `landing_optimization_completed` / `_failed` (already declared) | — | `run_id` |
| `estimate_failed` (already declared) | `error_code` | `run_id` |

Events the CLI reads but no client emits are either given a producer in this feature or marked `unsupported_by_producer` in the CLI (`update_*` after `update_started`, `install_detected`, `onboarding_*` of the legacy onboarding, `session_started`, `screen_viewed`, `result_*`).

## Envelope additions

`agent_instance_id` (uuid), `agent_platform` (`macos|windows`), `attempt_id` (opaque id) — set by `service.ts` from `setAgentContext` and from properties respectively.

## Eviction priority

`terminal` > `informational` > `progress`; `analytics_delivery_report` is never evicted.
