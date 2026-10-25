# Additive DB mini release review

2026-10-25. Independent policy/catalog and transaction/recovery reviewers cross-checked the implementation; the rehearsal owner additionally reviewed disposable resource ownership. Closed findings are recorded in [verification evidence](db-verification.json).

The admitted slice is nullable builtin columns and ordinary nonunique btree indexes. Actual catalog guards reject partitions/inheritance, custom access methods/types/collations/opclasses, relevant unknown event hooks, modified privileges/policies/routines and ledger write hooks. Official statement tuples stay unchanged; only their ordered closed-grammar correspondence to Git source is checked. Raw draft preflight does not invent execution tuples.

All DDL and official ledger inserts use one transaction. PostgreSQL17 whole-transaction and idle deadlines are verified on the actual connection before its prepared journal/BEGIN, including session-pooler startup handling. Independent observation classifies commit/abort; unknown results fence mini, inherited web, rollback, full and standalone backend writers. Prepared beta evidence cannot publish until fresh committed DB state is confirmed. Later web failure never causes a DB down/replay.

The real owned PostgreSQL17.11/pinned CLI2.117 harness passed vendor A = mini A, next full CLI B, unchanged synthetic old rows, allowed authenticated/denied anonymous access, commit-response loss without replay and confirmed atomic timeout abort after earlier DDL. The owned container/network were removed. The local source was read for definitions only. Docker internal networking stays enabled; a bounded loopback broker targets the exact owned container.

394 focused assertions and 69 existing release regressions passed. All 13 static gates have successful latest results: the canonical run reached a JSDoc type error after its first five passes; that annotation was corrected, the affected scripts check repeated and the remaining canceled gates completed through the same gate runner. Touched-file formatting also passed. The original failed aggregate receipt is retained; no fresh single green aggregate run is claimed.

This establishes local implementation/database acceptance. Real candidate beta schema/browser/unchanged sealed packaged-agent acceptance remains required before production. No production migration/upload or native rebuild/version/tag/asset operation was performed. RPC/RLS/data changes and broader SQL remain outside this mini path.
