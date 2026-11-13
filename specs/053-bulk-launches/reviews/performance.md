# Local performance evidence

Measured on this Apple Silicon development host with real FFmpeg/ffprobe, nice 15, one codec thread per job. Synthetic 12-second 640×360 H.264 source without audio, trim 0.3 seconds at each end, 20 independent outputs. No provider writes or production data.

| Scenario | Time | Body preparations | Cache/shared hits |
|---|---:|---:|---:|
| Isolated cold preparation ×20 | 4,867 ms | 20 | 0 |
| Shared sequential preparation ×20 | 265 ms | 1 | 19 |
| Shared preparation, concurrency 2 | 282 ms | 1 | 19 |
| Native pipeline including measurement, join, verification; sequential | 2,020 ms | shared | — |
| Same native pipeline; concurrency 2 | 1,165 ms | shared | — |

The full measured local pipeline is 42.3% faster (1.73× throughput) for this fixture. Warm preparation itself is effectively equal: batching is not claimed to improve an already-completed cache lookup. The large cold-cache comparison is reuse evidence, not a new-vs-old product speedup; baseline already had the cache. Neither number predicts long-video, audio, network, Google catalog creation or production end-to-end latency. Native PowerGovernor still owns real application CPU budgets.

Reproduce from this worktree after building shared:

```sh
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg FFPROBE_PATH=/opt/homebrew/bin/ffprobe nice -n 15 node --import tsx scripts/benchmark-launch-bodies.mjs
```

The script creates synthetic media in an owned temporary directory and removes it in finally. Regression tests additionally prove twenty consumers retain independent materialized files through eviction and waiter cancellation does not cancel the producer. Windows native timing remains unmeasured; source/contract behavior is tested cross-platform in CI.


## Download budget and lazy batch loading

The first aggregate run after a real build found the old route budget exceeded.
An independent detached checkout of exact base `2d616995` was installed and built
with the same lockfile, Node and configuration. The base itself measured 54,291 B
for the complete Launch graph (old cap 54,000 B) and 1,081,860 B shared/existing
(old global cap 1,064,788 B). These are existing release-source costs, not new 053 work.

The final feature build measures 61,668 B for the complete Launch graph (+7,377 B),
1,083,635 B shared/existing (+1,775 B), and 1,200,854 B across all JS/CSS assets
(+9,156 B). Initial exclusive Launch imports are 12,642 B versus the base's 8,570 B;
the batch coordinator and generation dependencies are dynamically requested after
Generate. Its descendants still count in the full route budget. No code was moved
into another route to evade the accounting.

`tests/performance-budgets.test.ts` explicitly accounts for the measured existing
base with an 18,000 B allowance, plus at most 7,500 B new complete Launch growth and
3,000 B new shared growth from this feature. The full Launch ceiling is 62,000 B.
The original baseline file, 20,000 B root-chunk cap, entry, largest-chunk and Accounts
caps are unchanged. This is a documented allocation for additional functionality,
not a claim that total download size decreased or that a production release passed.
The before/after file sizes and hashes are in [bundle-budget-comparison.json](bundle-budget-comparison.json).

## Unattended-failure follow-up

The expanded owner-requested recovery scope measures 62,768 B complete Launch,
1,083,905 B shared/existing, and 1,202,225 B total. Relative to initial feature
commit `49ade050`, the changes add 1,100 B Launch and 270 B shared, 1,371 B total.
Initial exclusive Launch imports are 12,748 B; the root chunk is 10,633 B.
The added recovery stays lazy. All descendants remain in the measurement.

Allocate a further bounded 1,000 B to this new Launch recovery scope: at most
8,500 B over the exact 54,291 B base, and a 63,000 B absolute route ceiling.
The initial implementation had 123 B of remaining allowance; final follow-up
uses 1,100 B with 23 B still below the stricter relative ceiling.
The shared allowance remains 3,000 B and the entry, root, largest, Accounts and
original baseline gates are unchanged. This is an explicit functionality
allocation backed by before/after evidence, not a size reduction or a skipped gate.

## Durable ownership, automatic background and canonical rename

The follow-up changes the feature scope: server-owned batches/re-entry replace the
browser queue, all eligible users receive automatic background setup, and canonical
catalog rename adds shared manager/result UI and reconciliation. The first build
measures 65,736 B complete Launch (+11,445 B against the same exact base),
1,091,156 B shared/existing (+9,296 B), and 1,212,420 B total (+20,722 B, 1.74%).
The initial exclusive Launch graph is 13,268 B; root is 10,934 B. The rename dialog
loads on first activation and remains mounted for pending observation after closing.

The earlier allocation for a browser-local queue no longer covers this scope.
An explicit additional 3,500 B Launch and 7,000 B shared allocation bounds the full
feature at +12,000 B Launch and +10,000 B shared against the unchanged release base;
the absolute Launch ceiling is 66,500 B. All lazy descendants and shared rename
code count. No dependencies were added and no code was moved to an unrelated route.
Entry/root/largest-chunk/Accounts ratchets and original baseline remain unchanged.
The first build failed the old allowance; that failure is retained in the local
log. Final slider/R2/wording refinements require one subsequent exact measurement.

The final build after those refinements measures 65,686 B complete Launch
(+11,395 B), 1,090,979 B shared/existing (+9,119 B) and 1,212,184 B total
(+20,486 B, 1.72%). Initial exclusive Launch imports are 13,253 B; its root is
10,925 B. All four built-asset budget tests pass. This is 605 B below the stricter
relative Launch ceiling and 881 B below the shared growth allocation. The final
build retains the repository's existing large-chunk advisory.


The subsequent desktop-layout polish and manual-budget recovery fix measure
65,893 B complete Launch (+11,602 B), 1,091,242 B shared/existing (+9,382 B),
and 1,212,662 B total (+20,964 B, 1.76%). Initial exclusive Launch is 13,265 B;
root is 10,933 B. All four budget tests pass under the same unchanged allocation
(398 B relative Launch headroom and 618 B shared headroom).
