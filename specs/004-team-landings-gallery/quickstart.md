# Quickstart & Validation: Спільна галерея лендінгів командного простору

**Feature**: `004-team-landings-gallery`

A run/validation guide, not implementation. Implementation detail lives in `tasks.md` and the
code. Use only **isolated local/linked dev** Supabase + Google **test** resources — no
production migration, deploy, tag, or release.

## Prerequisites

- Local Supabase stack up; the connected team + Drive root from 001 available (or seed one).
- A paired local agent build that includes the `teamWorkspace` tool contract with the new
  `/api/team/landings/*` routes (for render production and US3 interop).
- Env: `DRIVE_OAUTH_MODE=testing` (or `verified` against the canonical origin) per 001; shared
  rebuilt (`npm run build -w @video-compressor/shared`) before contract SQL/tests.
- Google **test** Drive folder containing: ≥1 direct HTML landing, ≥1 valid landing zip, ≥1
  candidate archive (not yet inspected), and ≥1 corrupt/oversized archive for negative paths.

## Local gates (must pass before PR)

```bash
npm run format:check
npm run lint
npm test                                   # builds shared, runs vitest
npm run build -w @video-compressor/web
npm run build -w @video-compressor/agent   # CI never builds the agent — do it locally
npm run types:supabase                     # after applying the new migration to dev
# DB + real-agent
#   pgTAP suite in supabase/tests/database/team-workspace.test.sql
#   npm run test:agent:e2e  (real-agent-check covers render + cached serve)
```

## Story validations

### US1 — Shared landings gallery (P1, MVP)

1. Seed the space with several landings + a second **hidden** team with its own landings.
2. As a member with **view** only, open the workspace → **Landings** view (≤2 actions, SC-001).
3. **Expect**: all this space's landings appear as tiles; the hidden team contributes zero
   tiles/counts/facets (isolation). Download/edit affordances are absent for a view-only member.
4. Open the gallery on an **empty** space → welcoming empty state, no filters, no side panels.

### US2 — Open a landing full view (P2)

1. From the gallery, open one landing.
2. **Expect**: the existing sandboxed navigable preview (screenshot fallback on error), no
   download to device. External navigation from the landing is blocked.
3. Toggle device preset, colour scheme, zoom → the view updates consistently (matches the local
   previewer).
4. Open a corrupt/protected/oversized/unsupported fixture → a truthful typed state, gallery
   stays working (no crash, no false "ready").

### US3 — Shared renders, agent lifecycle, previewer interop (P3)

1. **Shared render (SC-003)**: member A (with agent) opens/renders several landings; member B
   with **no running agent** opens the gallery → already-rendered landings are browsable; B
   renders nothing.
2. **Agent-required (SC-004)**: with no agent running, an un-rendered landing shows a truthful
   `needs_agent` state (or `agent_outdated` for an old agent); **zero** false "ready".
3. **Invalidation (SC-007)**: replace a landing's source in Drive → after one sync cycle the
   tile no longer shows the old render as current and asks for a re-render; the stale
   `.soty/landing-previews/…/<old-source>/` artifacts are cleaned.
4. **Interop (FR-016)**: open the connected space as a catalog in the standalone local
   previewer → identical landings and previews as the team gallery.

## Security & privacy checks (extend `tests/team-security.test.ts`)

- Landing content cannot reach session/account/external network; `sandbox='allow-scripts'`, CSP
  `connect-src 'none'`, and the navigation guard hold for both gallery thumbnails (inert WebP)
  and full view (SC-006).
- No log/error/audit/realtime/analytics payload contains Google tokens, Vault/grant ids,
  session URIs, email, filenames/paths/queries/Drive ids/metadata values, or landing content
  (FR-018).
- `landing_renders` base table blocks direct client access; read requires `view`; write/commit
  is service-only; committing with a mismatched source identity yields `stale`, not `ready`
  (pgTAP).

## Performance (SC-005)

- Seed ≥300 landings with renders; measure first-visible-page thumbnail render < 2 s p95 across
  3 runs; confirm smooth scroll via lazy loading. Record environment + p50/p95/p99/max.

## Automated evidence — 2026-08-10

Environment: Apple M1 Pro, Darwin 25.5.0 arm64, Node v24.13.0, Vitest + jsdom. The reference
gallery has 300 authoritative rows, a 50-tile first page, opaque WebP URLs, native pagination,
and `loading="lazy"` on every visible image.

| Scope            | Evidence                                                                                                                                                                                                             | Result |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| US1 / SC-001     | `team-landing-gallery.test.tsx`: direct workspace Landings entry, fixed `landing + archive` scope, foreign-team rejection, view-only controls, empty state, pagination                                               | PASS   |
| US2 / SC-006     | `team-landing-fullview.test.tsx`, `team-security.test.ts`: multi-segment cached view, controls, typed failures, inert WebP, sandbox/CSP/navigation guard                                                             | PASS   |
| US3 / SC-003/004 | `team-landing-render-sharing.test.tsx`: ready render stays viewable agent-less; missing/stale never becomes ready; old-agent state remains explicit                                                                  | PASS   |
| US3 / SC-007     | `catalog-sync.test.ts` + pgTAP: invalidate before catalog mutation, trash old artifact roots, exclude `.soty`, source-race commit becomes stale                                                                      | PASS   |
| FR-016 interop   | `team-landing-previewer-interop.test.ts` + `landing-preview-catalog.test.ts`: team enumeration, all segment grants, identical cached WebP, no persisted grant URLs                                                   | PASS   |
| Convergence      | `team-landing-render-bridge.test.ts` + `drive-transfer.test.ts` + pgTAP: overall render watchdog reaches a typed terminal failure with cleanup/refetch; hidden Drive paths are `<sourceVersion>-<fingerprint>` bound | PASS   |
| DB authority     | local `supabase db reset` then `npm run test:db`: all migrations from scratch, 2 files / 264 pgTAP assertions                                                                                                        | PASS   |

Final local gate record:

| Command                                    | Result                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                     | PASS                                                                                                                                        |
| `npm run lint`                             | PASS                                                                                                                                        |
| `npm test`                                 | PASS — 133 files passed, 3 manual files skipped; 760 tests passed, 6 manual tests skipped                                                   |
| `npm run build -w @video-compressor/web`   | PASS (production Vite build; size advisory only)                                                                                            |
| `npm run build -w @video-compressor/agent` | PASS                                                                                                                                        |
| `npm run test:db`                          | PASS — 2 files, 264 assertions                                                                                                              |
| `npm run test:agent:e2e`                   | PASS — real Fastify agent, v2 team contract/new routes guarded, legacy tools compatible, real FFmpeg cases completed with sources unchanged |

SC-005 first-visible-page measurements (20 samples per invocation):

| Run |      p50 |       p95 |       p99 |       max |
| --- | -------: | --------: | --------: | --------: |
| 1   | 8.023 ms | 11.485 ms | 20.543 ms | 20.543 ms |
| 2   | 8.523 ms | 13.202 ms | 13.379 ms | 13.379 ms |
| 3   | 8.293 ms | 11.221 ms | 17.553 ms | 17.553 ms |

All p95 values are below the 2,000 ms target. Only the 50 visible tiles mount, and all images
remain lazy, which is the automated smooth-scroll proxy; browser DevTools/manual scroll remains
part of the production click-through. SC-002 and SC-008 are moderated human outcomes and are
not fabricated by the automated suite; record the actual participant cohort after deployment.

## Evidence to record here

- Command outputs for the local gates; pgTAP + real-agent results.
- SC-001…SC-008 measurements (isolation, moderated open-a-landing cohort ≥18/20 < 30 s,
  agent-less shared-render viewing, zero false-ready, invalidation within one sync cycle,
  interop parity, ≥300-landing p95, ease-of-use ≥4/5), with reference-set version, conditions,
  and all attempts (not only successes), per the 001/002 measurement discipline.
