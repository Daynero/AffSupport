# Single budget / SUB final acceptance

Implemented in isolated `053-bulk-launches`, based on `d4c05130`. All 20 changed source/test/migration inputs match `single-budget-source.json` throughout verification.

- 63 focused behavior/contract/database tests passed after rebuilding shared output for the Edge adapter. Three existing diagnostic producer/sanitizer/CLI regressions and four built-asset budget checks passed.
- Canonical full verification passed all 14 static gates. Its first suite attempt completed 5,457 assertions without test failures, but stopped after four shards because the progress reporter hit host `ENOSPC`. The failed canonical record is retained in `single-budget-verification-enospc.json`.
- Repeated only the affected suite through `npm run verify -- --gates=suite`, including its shared-build prerequisite. Temporary files and ignored report outputs used an owned external directory; code, tests, timeouts and gate semantics were unchanged. All eight shards completed: 11,175 passed, 95 declared skips, zero failures. `single-budget-verification-final.json` is the unmodified canonical successful result. Together the recorded runs cover every required gate on identical source.
- Canonical isolated PostgreSQL: 75 SQL files / 1,490 assertions; 3 Auth tests; 81 native integration tests. The new native trigger tests and real profile/copy RPC regressions confirm the single representation and preserved legacy guards. No production schema writes.
- Actual desktop components in both themes, 960–1920px: bounded long SUB values, full hover text, live values, omitted unresolved slots; Single shows one per-campaign amount. Dark/light screenshots visually inspected. Downloads gallery and ZIP contain 18 desktop screenshots.
- Complete Launch bundle 66,058 B gzip, +165 B against the previous feature commit; total application +160 B. All existing allocations unchanged.

No deployment, release packaging, stable manifest/version edits, branch merges or remote pushes. Production/provider acceptance remains separate from these local synthetic checks. The historical ENOSPC was an environment/reporting failure, not a hidden green run.
