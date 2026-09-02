# Findings — feature 014 (video stitcher)

## A — the stitcher's shared module took team mode down locally (2026-09-02)

Reported by the owner: in team mode transcription failed and landings would not open, both
with the red "Сервер відповів несподівано. Спробуйте ще раз." Reproduced in the running beta:
`POST /functions/v1/drive-ops/process/start` answered `503 {"code":"BOOT_ERROR"}`, which is not
a team error envelope, so the client mapped it to `INVALID_RESPONSE` — hence one sentence for
two unrelated-looking features. Both go through `drive-ops` (process start; preview), so both
died with it.

`docker logs supabase_edge_runtime_wishly` named the cause:

```
worker boot error: failed to bootstrap runtime: failed to create the graph:
Module not found "…/packages/shared/dist/stitcher.js"
    at …/packages/shared/dist/types.js:7:15
```

The local Supabase stack **bind-mounts one file per module** of each function's import graph,
resolved when the stack starts — the container had `dist/types.js` but not `dist/stitcher.js`,
which appeared an hour later when 014 added `packages/shared/src/stitcher.ts` and `types.ts`
re-exported it. `drive-ops` and `library-ops` were the only two functions importing the
`dist/types.js` barrel; every other function already imported the `team/*` module it needed and
kept working, which is why the failure looked feature-specific rather than stack-wide.

### Fixed

| What | Where |
| --- | --- |
| `drive-ops` and `library-ops` import `team/contract`, `team/material-category`, `team/transcript`, `team/transport`, `team/creative-library`, `team/library-processing` — never the barrel | `supabase/functions/{drive-ops,library-ops}/index.ts` |
| Regression guard: no function may import `shared/dist/types.js` | `tests/team-contract.test.ts` |
| `beta:up` now boots every function and refuses to report beta up while any answers a 503 that is not a team error envelope | `scripts/beta-up.mjs` |

The old readiness probe asked for a function that does not exist, so a runtime that could not
boot `drive-ops` passed it happily and beta reported itself up — the product looked broken with
nothing in the startup output to say why. That gap is what turned a one-line cause into a
debugging session.

Verified live after the change: `drive-ops` answers `401` unauthenticated (it boots), a landing
opens in the safe viewer, and a team transcription starts and runs to completion.

Production is unaffected: deployed functions are bundled at deploy time, so the mount trap is a
local-stack property only.
