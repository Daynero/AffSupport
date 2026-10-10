# Analysis artifacts (`audit --write`)

`npm run analytics -- audit --period <t> --as-of <iso> --write` saves one file here,
`<as_of date>.json` (UTC calendar day of `--as-of`, or of the run when `--as-of` is
absent). Without `--write` nothing is written. The files are gitignored
(`analysis/*.json`); only this README is tracked.

## What a file holds

```json
{
  "ok": true,
  "command": "audit",
  "as_of": "2026-10-10T00:00:00.000Z",
  "period": {
    "token": "30d",
    "start": "...",
    "end": "...",
    "label": "last 30 days",
    "as_of": "..."
  },
  "data": {
    "registry_size": 0,
    "capabilities": [
      {
        "id": "compressor.run",
        "status": "covered|partial|uncovered|declared_but_never_emitted",
        "missing": [],
        "samples": 0,
        "orphan_starts": 0,
        "correlated_pairs": 0,
        "producer_status": "emitted|pending_producer|unsupported_by_producer"
      }
    ],
    "unknown_codes": [{ "tool": "compressor", "errors": 0, "unknown_code": 0, "unknown_stage": 0 }],
    "delivery": {
      "reports": 0,
      "rejected": 0,
      "evicted": 0,
      "expired": 0,
      "by_event": [],
      "note": "..."
    },
    "uncovered_builds": ["1.2.4"],
    "delivery_lag_ms": { "p50": 0, "p95": 0, "samples": 0 },
    "findings": [
      {
        "id": "sha256(capability|status|missing)",
        "capability": "...",
        "status": "...",
        "severity": "high|medium|low|info",
        "missing": [],
        "evidence": []
      }
    ],
    "summary": { "covered": 0, "partial": 0, "uncovered": 0, "declared_but_never_emitted": 0 }
  }
}
```

There is deliberately no `generated_at`: the same snapshot with the same `--as-of`
produces byte-identical files (SC-017), so a diff between two dates shows only what the
product or its analytics changed. Finding ids are `sha256("<capability>|<status>|<sorted
missing>")`; the same blind spot keeps the same id across runs, and `evidence` (counts)
is outside the hash so it can move without duplicating the finding (SC-007).

## Reading one

- `status: covered` — start and terminal observed with the same correlation id.
- `partial` — `missing` names what did not arrive: `terminal`, `start`, `readiness`,
  `start_correlation`, `terminal_correlation`, `correlated_pair`.
- `uncovered` — no event of the capability in the period. With
  `producer_status: emitted` something is wrong or unused; with `unsupported_by_producer`
  it is a known blind spot (`unobservable` says why).
- `declared_but_never_emitted` — a CLI metric still computes from an event no client
  emits (SC-014 wants this at zero).
- `orphan_starts` — starts whose id never met a terminal inside the period; a run that
  ended after `as_of` is an orphan in that snapshot and not in the next.
- `delivery` — sums of `analytics_delivery_report` counters; `reports: 0` means losses
  are unknown, not zero.
- `uncovered_builds` — web builds that emitted no link event (predate 032 or lost
  analytics); a zero elsewhere from them is "not observed".

The registry the audit compares against is `scripts/analytics/coverage-registry.ts`.
