# Screen range authority — working increment

This unverified increment is isolated in recovery-next. Migration162000 has not
been applied to the running beta, and no route or capability is exposed.

The private grant binds the accepted owner, epoch, native boot, frozen screen,
acquisition and original reservation. Issue is atomic with budget CAS. Consume
uses a fresh server invocation UUID and permits one dispatch; unknown ACKs may
resolve only that invocation by exact readback. The protected bridge reuses its
original reservation and keeps the measured reader/late settlement boundary.
Unused grants can close with proved zero cost. Consumed uncertainty stays held.
Expired unused refresh spends the same durable candidate/global refresh budget.

Current diagnostics add bounded authority counts, never token/hash, provider
identity, checksum or content. Grant transitions advance observation time. Old
schemas retain unknown authority counts rather than invented zeroes. A consumed
grant proves neither actual I/O nor image validation, video output or delivery.

The combined focused run passes166 tests in8 files, including61 actual SQL
storage cases, real issue/consume adapters with lost-ACK readback, strict purpose
separation, cancellation/abandonment, expiry/refresh budgets, immutable original
responses, safe grant-state projection and SELECT-only CLI consumption. The
5001-folder fixture initially timed out under disk pressure. Measurement separates
~13.3s fixture insertion from the ~24ms bounded query; its test setup allowance is
now30s, with no product deadline change. An incorrect diagnostic test expectation
was corrected: two earlier accounted ranges remain accounted, independently of
the new grant counts. Both original failures and the clean run are retained.

A lightweight direct Node probe also passes exact lost-ACK issue/consumption with
one mutation each. The first native replay applied all445 migrations but exposed missing global
Task cleanup coverage for the new JSON-bearing grant ledger. The migration now
installs the same mandatory late-reference fence as other consumers; the actual
SQL coverage regression passes. The failed native run was explicitly stopped
without acceptance, and its canonical parent disposed its owned database. No
application/source data was copied or changed. The three native PostgreSQL races
have not run yet because that first pgTAP phase failed.
Canonical static/full-source checks, native migration replay, installed executor
and manual beta acceptance remain pending. No complete feature acceptance is
claimed from this internal increment.

Native control/source purpose integration, observed managed-child quiescence,
root retirement, rejection persistence and the product fallback controller remain
open tasks. This foundation alone does not complete T015–T020 or feature047.

The subsequent combined314-test run is not acceptance:313 pass, the5001-folder
fixture exceeds its30s setup allowance under renewed host memory/swap pressure,
and Vitest reports a worker update timeout. No timeout was increased again.
Resource isolation and a clean rerun remain required; all failed logs are retained.
