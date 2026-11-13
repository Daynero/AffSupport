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
