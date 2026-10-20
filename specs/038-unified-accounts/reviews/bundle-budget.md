# Download budget accounting for 038

The unchanged global baseline is 956,941 gzip bytes, with its existing 5% tolerance.
The entry baseline remains 6,019 bytes and the largest-chunk baseline 136,110 bytes.
This change does **not** refresh them from a newer, already larger application.

Feature 038 adds unified finance/runs, archive workflows and library-backed manual
ordering to the existing lazy Accounts route. It receives an explicit incremental
exclusive-route allowance of 55,000 gzip bytes. The complete exclusive Accounts
graph is also capped at 80,000 bytes. This is a new feature allowance, not a claim
that the complete application became smaller or that every previous fence is
unchanged.

The existing Launch root limit remains 20,000 bytes. Its complete exclusive graph,
including secondary views loaded on demand, receives a new cap of 40,000 bytes.
That complete-graph cap was not part of the previous root-only budget. It allows
approximately 6.7% headroom over the measured 37,491-byte graph; the provisional
35,000-byte design estimate was replaced by this measured choice. Moving code
into a second chunk does not remove it from this route budget. Actual conditional
loading can reduce the initial list download, but the entire private route graph
remains measured.

## Measurement

`scripts/lib/lazy-route-assets.mjs` reads Vite's build manifest. For each feature:

1. Traverse its static and dynamic dependencies, including linked CSS.
2. Traverse every actual application entry while cutting dynamic-import edges into
   the feature root. Do not treat its private dynamic children as separate roots.
3. Its exclusive assets are those reachable through the feature but unreachable
   through that outside traversal. Shared dependencies remain global. A route
   statically reachable outside its lazy boundary fails closed.

The global total still includes every built JS/CSS asset, including assets absent
from the manifest. Asset paths are deduplicated. No chunk-name renaming, package
name exclusion or manually selected dependency list controls the allowance.

The ratchet comparison is:

```text
accountsIncrement = max(0, currentAccountsExclusive - pre038AccountsExclusive)
existingBytes = totalBuiltJSAndCSS - currentLaunchExclusive - accountsIncrement
existingBytes <= round(956941 * 1.05)
accountsIncrement <= 55000
currentAccountsExclusive <= 80000
currentLaunchRoot <= 20000
currentLaunchExclusive <= 40000
```

The **complete** old Accounts exclusive graph remains charged to `existingBytes`.
Its root chunk alone is insufficient evidence: subtracting old private
dependencies too would forgive existing costs. Shared dependencies introduced by
038 remain charged globally even when a library was added for this feature.
The current Accounts and Launch exclusive sets must be disjoint.

## Baseline evidence and status

The pre038 source is immutable commit
`4c392f6316a0a6ad1f02e4acc0b30bb1df91e10b`. Its isolated build uses the same installed
dependencies as the feature build. The versioned companion
`bundle-budget-baseline.json` records the complete manifest-derived Accounts
exclusive graph, gzip sizes and asset hashes. The test verifies the source commit,
route source key, unique files, valid hashes and the sum of its recorded sizes. It
recomputes the exclusive graph from the embedded original manifest and checks
each exclusive asset against the original complete asset inventory.
It never substitutes a guessed root-chunk size for this graph measurement.

The isolated pre038 measurement is complete. Its entire exclusive Accounts graph
is exactly one asset, `assets/AccountSpace-_Thm8kT2.js`, at **24,413 gzip bytes**.
The manifest SHA256 is
`6a4592d965c1534775f4136f0c1fbcc966c82d3e22cb35b4f44203a02845a059`.
The evidence records Node 22.23.2, macOS arm64, the build command and workspace
dependency-link conditions. The complete graph happens to equal the root chunk
in this build; that equality was measured, not assumed.

## Optimization experiment, before canonical verification

The local build experiment uses the official locale optimization plugin with
`en-US`, `en-GB` and `uk-UA`, preserving all product-supported interface languages
and the English fallback. It also loads the Launch session only when its modal is
opened. The session has loading, failure and retry handling rather than an
unhandled dynamic import. No alternate minifier dependency was adopted.

The recorded `scratchpad/038/locale-experiment-sizes.json` measurement is:

| Metric                            | Gzip bytes |
| --------------------------------- | ---------: |
| All built JS/CSS                  |  1,089,989 |
| Complete Accounts exclusive graph |     74,028 |
| Retained pre038 Accounts cost     |     24,413 |
| Explicit 038 Accounts increment   |     49,615 |
| Complete Launch exclusive graph   |     37,491 |
| Launch root                       |      7,802 |
| Global existing/shared comparison |  1,002,883 |
| Unchanged global ceiling          |  1,004,788 |

The resulting global comparison is below its unchanged ceiling. This is a local
optimization experiment, not a canonical verification result. The complete
application is larger than pre038; the separately bounded feature increment and
shared-resource optimization explain the accounting. The helper, fixture tests
and new accounting are implemented. The subsequent canonical feature build succeeded. Final measured values and gate
status follow below; full repository verification remains separate.

## Limits

Gzip bytes are a download proxy, not evidence of rendering responsiveness, mobile
latency, drag frame timing or the SC004 acceptance criterion. The manifest models
build dependency reachability; actual network caching, browser preload behavior
and conditional runtime execution are separate concerns. Entry and largest-chunk
ratchets continue to protect against concentrating code into an eagerly loaded or
oversized asset. Fixture tests cover shared dependencies, private lazy children,
cross-route references, cycles, multiple application entries, malformed graphs
and unreachable routes. No coverage floor is changed by this budget revision.

## Canonical feature build measurement — 2026-10-18

`npm run build:web` succeeded after the best-effort diagnostics and mobile Launch
header correction. The actual dist manifest gives:

| Metric                            | Gzip bytes |
| --------------------------------- | ---------: |
| All built JS/CSS                  |  1,090,027 |
| Complete Accounts exclusive graph |     74,028 |
| Explicit Accounts increment       |     49,615 |
| Complete Launch exclusive graph   |     37,514 |
| Launch root                       |      7,814 |
| Existing/shared comparison        |  1,002,898 |
| Unchanged global ceiling          |  1,004,788 |

The helper's eight graph fixtures and all four budget checks passed in the
preceding focused run (five files / 137 tests). The final build changed only the
bounded mobile heading presentation and best-effort telemetry wrappers. The
full canonical runner must independently confirm the budget on this build.
`performance-baseline.json` remains unchanged. The subsequent release coverage
audit retired exactly one record for the already-deleted pre038
`TaskAssigneeFilter.tsx`; every live-file threshold and the global coverage floor
remain unchanged. See `retired-coverage-entry.json` for the verified diff.
