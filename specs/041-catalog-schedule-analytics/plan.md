# Implementation plan

1. Add private committed-settings journal, final-state deferred capture and restricted analytics view; observe current catalogs as explicitly dated baselines.
2. Add read-only catalog-trends query and aggregation contract with current/transition/daily/user/options/clock projections and explicit limits/coverage.
3. Extend CLI with optional user scope and HTML output; render self-contained SVG charts and per-catalog user timelines.
4. Verify DB capture and permission boundaries, query counting/as-of behavior, CLI wiring and safe HTML. Apply only to local beta, produce a local report and inspect in desktop Chrome.
5. Update analytics CLI documentation and coverage inventory; record actual verification and remaining pre-release limits.
