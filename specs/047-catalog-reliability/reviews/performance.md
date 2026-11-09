# A26 catalog manager performance

Status: **browser latency NOT MEASURED; T053 remains open**. The automated harness below checks counts and semantics only. It does not treat jsdom duration, React Profiler duration or test-run wall time as input-to-paint latency. No p50/p95 or SLA result is claimed.

## Reproducible synthetic fixture

`tests/fixtures/catalog-manager-performance.ts` exports sizes **0 / 60 / 500 / 2000**, seed **47**, fixed timestamps and stable IDs. Exactly half match `льон`. Long duplicated Ukrainian catalog names are paired with unique video names and IDs. Profiles include all settings, N, schedule, success/attempt/error evidence and mixed success/running/error/held scenarios. The held fixture represents known pending/partial signals; it does not fabricate a confirmed provider delivery or private publication-policy read.

`tests/support/catalog-manager-performance-harness.tsx` mounts the actual manager with a frozen, injected client and real Team/Toast providers. All data is synthetic; every mutation rejects and is counted. It exports injected-client read-call, profile-element-access and whole-subtree React commit counters. DOM row count is not an individual-row render count; browser network requests still require a separate HAR/trace capture. React commit counts are valid only when `profilerObserved` is true: ordinary production React may disable the callback, in which case renders are unknown, never zero. If a profiling production build is used, use the same instrumentation for baseline/after and record it explicitly. The browser caller must supply its existing authenticated context if needed; the harness introduces no product route, auth setting, endpoint or release activation.

`tests/catalog-manager-performance.test.tsx` checks bounded initial DOM rows, full-list search by an offscreen stable ID, select-all across all matching records, local details open/close without transport reads or writes, bounded commits and a linear fallback profile join. Autonomous polling/countdown intervals are frozen in the isolated count test. Timing is deliberately not asserted. All **6 count/semantic guards passed** in the root aggregate run `68113` (226/226 tests across 14 files). This is automated count evidence only; browser p50/p95 remains unknown.

## Browser protocol (baseline and after)

1. Use an isolated test-only browser fixture document built in production mode from the same beta web build configuration, loading the exported harness. Do not add a product route or change authentication. Do not use real rows. Seal the exact baseline and after source/build IDs; if a matching baseline artifact is unavailable, mark it unavailable and leave the comparison open.
2. Record commit/source digest, clean/dirty state, web bundle digest, OS/version, CPU, RAM, browser/version, viewport **1440×900**, app power **100%**, AC/battery state and other significant load. Keep CPU/network throttling disabled. Use the same machine and browser for baseline/after. Record a second OS for functional/stress parity; different hardware is not a direct latency comparison.
3. Run each required fixture size. Capture cold authoritative initial load **10 times**, keeping network/transport time separate and retaining the browser HAR/trace (the injected-client counters alone do not prove the absence of unrelated network requests). After the initial authoritative fixture load, freeze autonomous polling and transport in the isolated fixture document only; keep the complete rows/profiles available. Record read counts before/after. Do not freeze the production app or another tab.
4. For each action, perform **10 warmups**, then **50 measured samples**: (a) search/filter with half matches; (b) toggle selection; (c) open/close details by stable catalog ID. Include a full-search/offscreen-ID and select-all-across-window correctness check. Reset local state between samples without re-fetching the fixture.
5. Boundary: the input handler starts until the next paint showing the required DOM state. Use a browser trace or verified frame sequence. A bare `requestAnimationFrame`, `performance.now()` around dispatch, React commit or a jsdom timer is not sufficient proof of that paint. Keep trace/frame references alongside every raw sample.
6. Save raw samples, rendered-row counts, commit counts and read counts. Compute p50/p95 only from the 50 measured samples per action and size, excluding warmups. At **500 rows each action p95 must be ≤200 ms**. At 2000 rows report stress results, crashes and finite read/commit counts; do not invent the same latency SLA.

## Raw evidence

`performance.raw.json` is an explicit **NOT MEASURED** template. Empty samples and null percentiles are unknown, not zero and not a pass. Fill baseline and after records only from actual browser measurements. Retain raw trace/frame artifacts, environment, source/bundle IDs, cold-load samples and any failed/aborted action. T053 cannot close from automated count guards alone.

| Size | Browser baseline | Browser after | Search p95 | Selection p95 | Details p95 |
| ---: | ---------------- | ------------- | ---------- | ------------- | ----------- |
|    0 | Not measured     | Not measured  | Unknown    | Unknown       | Unknown     |
|   60 | Not measured     | Not measured  | Unknown    | Unknown       | Unknown     |
|  500 | Not measured     | Not measured  | Unknown    | Unknown       | Unknown     |
| 2000 | Not measured     | Not measured  | Unknown    | Unknown       | Unknown     |

## Prepared real-browser runner (not executed yet)

`node scripts/catalog-manager-browser-performance.mjs` without `--execute` only prints usage. The runner has **not been executed**. All 3 pure proof guards passed in `28510`; full script types (`64686`), owned fixture/entry types (`33346`) and scoped lint (`38678`) passed. These checks do not launch a browser or establish any measured latency. It uses the already installed `playwright-core` and existing Chromium executable; it never installs or downloads a browser. No beta app, backend, auth flag, product route or deployment is changed. It launches a separate temporary browser context with a test-only synthetic `AuthContextOverride`, a frozen fixture client and rejected writes. That is **not authentication or entitlement acceptance**.

After the parent explicitly releases the single heavy slot, the concrete full command is:

```bash
nice -n 15 env TMPDIR=/Volumes/LaCie/DevData/Soty/tmp NODE_OPTIONS=--max-old-space-size=2048 RAYON_NUM_THREADS=1 UV_THREADPOOL_SIZE=2 GOMAXPROCS=1 \
  node scripts/catalog-manager-browser-performance.mjs \
  --execute \
  --output=/Volumes/LaCie/DevData/Soty/Benchmarks/047-a26/702e151-current-UNIQUE-RUN \
  --baseline=702e151 \
  --power-percent=100
```

This is a prepared operator reference, not authorization to bypass the active computer-use boundary. Automated browser execution must remain within the available/authorized browser-control surface; current agent work is limited to static checks and pure helper tests.

The output directory must be new/empty and outside the worktree. The runner also puts its temporary browser/build profile under that external output directory and sets only its own TMPDIR/TMP/TEMP. If the installed Playwright browser is missing, the command refuses; use `--browser-executable=/absolute/path/to/an/already-installed/Chromium` rather than downloading anything. Default is headed Chromium; `--headless` is a separately recorded environment choice and cannot be silently mixed with a headed baseline. At least 2 GiB free RAM and nice priority 15 are required. The power field is an operator declaration; retain independent actual power/AC evidence. The runner resets only its own CDP CPU/network throttling to none. It does not stop existing apps or browser sessions.

### Exact comparison scope

The baseline is the actual Git blob `702e151:apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`. The runner resolves and records the full commit, original source hash and generated import-rewritten hash. It creates an external ignored copy and rewrites only relative import paths back into the **current** dependency graph. The after build uses the current Dialog bytes with the same import rewrite. Both use the current actual production Vite configuration in `mode: beta`, current installed dependencies, current fixture wrapper and the same `apps/web/src/styles/index.css` cascade. `.env` files and inherited VITE configuration are not loaded; only the report's explicitly public synthetic beta flags are defined, with `VITE_LOCAL_DEV_AUTH=false`.

This is a **one-file historical Dialog comparison**, not a whole historical app/release comparison. In particular, changes in the shared `useCatalogUpdater` hook, CSS, packages or other components are common to both and cannot be attributed to the Dialog delta. The HEAD baseline already has a 60-row window; do not describe it as an unwindowed list. The current dependency/lock hash, working-tree status, generated bundles and per-file bundle digests are retained. Compiled CSS content digests must match exactly or the runner stops before browser measurements. A different baseline scope needs a separate reviewed experiment.

### Paint proof and raw output

The isolated page arms a capture listener **before** input. It marks input/pointer-up before React handlers, observes the required DOM state in the next animation frame, then retains the next-frame boundary. Search verification checks IDs and the full remaining-row count, not merely a 60-row window. Each measured sample has a viewport PNG. Chromium tracing must also contain the corresponding page-frame `Paint` followed by `DrawFrame` after the state mark and before screenshot capture. A double RAF without those events yields an unknown latency, not a measurement. The reported boundary is a verified renderer draw frame, **not physical monitor presentation**. Traces and screenshots remain available for review; unsupported trace shapes fail proof instead of inventing numbers.

Each phase runs all four sizes, 10 independent cold loads, 10 warmups and 50 measured search/selection samples. Details open and close each receive 10 warmups and 50 samples. Empty-fixture selection/details are explicitly N/A. Cold entry-to-draw and navigation-relative timings are separate from action timings and retain raw navigation entries. Every action reports the raw sample, before/after injected reads, DOM rows/mutations, renderer proof and React commits (null if production profiling is unavailable). Network requests/blocked external attempts are retained separately; unexpected cross-origin requests invalidate the run.

`report.json`, generated external sources, build outputs, traces and PNGs stay under the external output directory. Warmups never enter percentiles. Percentiles use nearest rank and require all 50 verified action samples (all 10 for cold loads); incomplete groups keep headline percentiles null. Missing/invalid frame proof does not become zero. The runner reports failed/incomplete samples and exits nonzero for unknown or failed 500-row targets; it never automatically marks T053 complete. Copy only reviewed results into `performance.raw.json`, with trace references, second-OS parity and the stated scope limitations.
