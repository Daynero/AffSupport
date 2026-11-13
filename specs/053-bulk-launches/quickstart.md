# Acceptance guide

Work only in AffSupport-053. Install dependencies in this checkout; do not rebuild through another checkout's node_modules workspace symlinks. Run heavy commands with nice 15 and Vitest --maxWorkers=1 --no-file-parallelism.

1. Mixed launch fixture: draft, busy, ready, failed, partial, canceled; verify light/dark and narrow layout, keyboard selection/duplicate/archive, chronology across two pages.
2. Save four same-video drafts with five variations each. Select and Generate; inspect bounded dispatch and independent per-launch outcomes. Double click, reject one stale draft, stop queue and change team; no duplicate submissions.
3. Delay generation response: Results shows campaign names before completion; reserved catalog name when available; no pending link copy. Copy success remains visibly marked; denied clipboard does not mark.
4. Run cache regression with 20 compatible consumers, incompatible trim, cancellation and eviction; report cold/warm conditions separately. Native performance claims require actual timings, not only mocked call counts.
5. Diagnostic tests: producer/sanitizer/inspect retention and unknown evidence. Run npm run verify; record exact results and remaining runtime-only acceptance in reviews/validation.md.
