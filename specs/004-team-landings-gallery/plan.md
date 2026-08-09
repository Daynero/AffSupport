# Implementation Plan: Спільна галерея лендінгів командного простору

**Branch**: `004-team-landings-gallery` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-team-landings-gallery/spec.md`

## Summary

This feature adds the one content surface the team space still lacks: a **shared landings
gallery** over the connected Google Drive space. Today a team landing can only be opened one
at a time as a modal (`apps/web/src/team/preview/MaterialPreview.tsx`), and the only
multi-landing gallery that exists anywhere is the **non-team** local previewer
(`apps/web/src/landing-preview/` + `apps/agent/src/landing-preview/`), which reads a local
folder. The gap: no team-scoped, multi-landing, all-members view of the space's landings.

The design reuses, rather than rebuilds, four existing pillars:

1. **Classification & listing** — landings are already `category === 'landing'` in the
   catalog (`packages/shared/src/team/material-category.ts`), so the gallery is a
   `category=landing`-scoped view over the existing `searchCatalog` RPC and
   `useCatalogSearch` hook — no new listing path.
2. **Rendering engine** — the same `LandingPageRenderer` (Playwright → full-page WebP
   segments) powers both the local previewer (`apps/agent/src/landing-preview/renderer.ts`)
   and the team single-preview fallback (`apps/agent/src/team-bridge/preview.ts`). The
   gallery reuses it; "works together with the local previewer" (FR-016) is literally the
   shared renderer plus a shared viewer-preset model (device / colour scheme / zoom).
3. **Safe preview** — the sandboxed local capability-origin, locked CSP, and navigation
   guard (`apps/agent/src/team-bridge/preview-origin.ts`) and the view-gated preview RPC
   (`private.can(p_team,'view',…)` in `supabase/migrations/20260801101500_team_preview.sql`)
   are reused verbatim: a plain viewer can already preview a landing (FR-002, FR-010, FR-011).
4. **Cloud byte serving** — `drive-transfer` already streams media bytes (bounded Range,
   no-store) to the browser without an agent; the shared-render cache reuses that path so an
   agent-less member can fetch a cached render image (FR-007, SC-003).

The one genuinely new capability, and the plan's central decision (see `research.md`), is
**shared render persistence**: to satisfy FR-007/SC-003 ("a landing rendered by one member is
viewable by another **without** that member's local app running"), a produced render must be
stored somewhere the whole team can fetch it without an agent. The plan stores render
artifacts in a **hidden folder under the connected Drive root** (`.soty/landing-previews/`),
keyed by the material's immutable `sourceVersion` + `fingerprint`, so a replaced landing
invalidates its render automatically and cleanup rides on the existing catalog-sync tombstone
path. This honours the spec assumption "no new cloud storage or auth" and reuses the shared
Drive connection + `drive-transfer` byte path; Supabase Storage and Postgres-blob alternatives
were considered and rejected (`research.md` §1).

The work is delivered in three independently shippable increments matching the spec's user
stories: **US1** an agent-backed gallery (thumbnails rendered locally by the viewer's paired
agent, like today's single preview), **US2** open-from-gallery full preview with previewer
viewing controls, **US3** shared render persistence (agent-less browsing), truthful
agent-required states, and local-previewer catalog interop.

## Technical Context

**Language/Version**: TypeScript 5.9.3, `strict: true`, ESM (`NodeNext`, ES2022). React
19.x function components (web), Fastify agent, Deno Edge Functions (Supabase). Internal
imports keep `.js` specifiers.

**Primary Dependencies**: Existing stack only. Web: `teamApi` (`apps/web/src/api/team.ts`),
agent client wrappers (`apps/web/src/api/client.ts` incl. `landingGallery*`,
`openTeamAgentPreview`, `toolContractCompatible('teamWorkspace', …)`), `TeamContext`,
`useCatalogSearch`, `useTeamRealtime`, `useI18n`, `components/ui`/`Modal`. Agent:
`landing-preview/renderer.ts` (Playwright `chromium`), `team-bridge/preview.ts` +
`preview-origin.ts`, the `ToolModule` seam. Shared: `packages/shared/src/team/*`. No new
third-party dependency.

**Storage**: Reuses the connected Drive root (new hidden `.soty/landing-previews/` subtree
for render artifacts) + Postgres catalog. New forward-only migration adds a `landing_renders`
record table and service-definer RPCs; render artifacts themselves are Drive files, not DB
blobs. No new Supabase Storage bucket. Client persists only viewer presets (device / colour
scheme / grid) under a new `localStorage` key; authoritative data stays server-side.

**Testing**: Vitest. DB/RPC via PGlite in `supabase/tests/database/team-workspace.test.sql`
and `tests/*.test.ts`; DOM via `// @vitest-environment jsdom` `*.test.tsx` in `tests/` with
`TeamContextOverride` + injected client stubs; agent integration via `mkdtemp` +
`afterEach` cleanup and the `ToolModule` assembly pattern. Security regression extends
`tests/team-security.test.ts` (no tokens/paths/content leak; sandbox holds).

**Target Platform**: Cloudflare Pages web + local Fastify agent (macOS packaged app) +
Supabase (local/linked dev). No production deploy, migration push, tag, or release in scope.

**Project Type**: Existing npm-workspaces monorepo. Changes span `packages/shared`,
`supabase/` (one migration + Edge changes), `apps/agent`, and `apps/web` — but every seam is
an established one.

**Performance Goals**: Gallery of ≥300 landings shows its first visible page of thumbnails in
< 2 s p95 and scrolls without jank (SC-005) via paginated/lazy thumbnail loading (FR-017).
Cached-render fetch (agent-less) reuses the media Range path's latency envelope. Rendering a
single landing reuses the existing agent render timings — not a throughput target.

**Constraints**:

- **Reuse the security posture, don't open a hole beside it** (Constitution III): preview
  stays view-gated; render-artifact writes to Drive use a **service/scoped-grant** path with
  the shared account (never a broad browser token), exactly like US5 process-output upload;
  new SQL functions are `security definer` with `search_path=''`, fully-qualified, `revoke
  all` then narrow `grant`. Render artifacts carry no session/account data.
- **Sandbox is inviolable** (FR-011): landing content keeps `sandbox='allow-scripts'`, CSP
  `connect-src 'none'`, and the navigation guard. Cached render images are inert WebP served
  no-store; they never execute.
- **Agent contract compatibility**: new agent routes live under the `teamWorkspace` tool
  contract; old agents fail only the new gallery routes with `AGENT_UPDATE_REQUIRED`, never
  break existing tools (Constitution II, mirrors 001 T121).
- **Invalidation by source identity**: a render record is valid only while its
  `sourceVersion` + `fingerprint` match the current material (same rule as
  `hasVersionedLandingProof`); a changed landing never shows a stale render as current
  (FR-006, SC-007).
- Keep the tree `any`-free; i18n keys compile-checked across `en`/`uk`; telemetry
  content-free through `analytics.track` with names in `TeamAnalyticsEventName` (FR-018);
  `className` + CSS custom properties, no inline static styles; a11y + no horizontal scroll
  (FR-019).

**Scale/Scope**: 3 user stories, FR-001…FR-019, SC-001…SC-008. Bounded by 001's per-team
limits (≤50 members, ≤50,000 catalog rows; landings are a subset). One new migration, one
new Edge concern folded into `drive-transfer`/`catalog-sync`, agent `team-bridge` extensions,
and a new `apps/web/src/team/landings/` surface. No change to billing or any 001/002
out-of-scope item; team/space deletion remains a separate follow-up.

## Constitution Check

_GATE: evaluated before research and re-checked against the Phase 1 design below._

| Principle | Gate | Post-design verdict |
| --- | --- | --- |
| **I. Type-safe contracts** | New render/gallery/viewer-preset types are string-literal unions + discriminated results in `@video-compressor/shared/team`; Drive-sourced render manifests and agent payloads are parsed as `unknown` and narrowed (never `as`); render validity reuses the versioned-proof guard. Internal imports keep `.js`. | **PASS** |
| **II. One source of truth** | Version/protocol unchanged. New agent routes register under the existing `teamWorkspace` tool contract in `release.ts` (bump that tool's contract version only, not `PRODUCT_VERSION`/`AGENT_API_VERSION` unnecessarily); old agents get `AGENT_UPDATE_REQUIRED` on gallery routes. Analytics names join `TeamAnalyticsEventName`. Shared rebuilt before contract SQL/tests. | **PASS** |
| **III. Security/least privilege** | New tables get RLS `revoke all` → narrow grants; render RPCs `security definer` + `search_path=''` + fully-qualified + caller/service checks (view to read a render pointer, service/scoped-grant to write an artifact). No browser Drive token; artifact serving reuses the audited `drive-transfer` byte path. Sandbox/CSP/nav-guard unchanged. | **PASS** |
| **IV. Child-process/resource orchestration** | Agent render reuses the existing `LandingPageRenderer` (Playwright) discipline: bounded output, `mkdtemp` + `try/finally` cleanup, cancellation/watchdog holding the live child, SIGTERM→SIGKILL. Range-download + artifact upload reuse the US4/US5 bounded-relay + `part.file.resume()`/`truncated` rules. | **PASS** |
| **V. HTTP/error conventions** | New agent routes return the tool state snapshot / `{ error: MACHINE_CODE }`; reuse `AGENT_REQUIRED` (409), `AGENT_UPDATE_REQUIRED`, `PERMISSION_DENIED`, `OAUTH_APPROVAL_REQUIRED`; Edge keeps `{ ok:false, error:{ code, retryable } }`. No new envelope; branch on codes, not text. | **PASS** |
| **VI. Frontend composition/state** | Gallery state lives in a new `useTeamLandings` hook layered on the existing `useCatalogSearch`/`useTeamRealtime` seams and the throwing `useTeam()`; viewer presets reuse the local previewer's preset model. Agent/Supabase calls go through the typed wrappers only. Live updates via the existing Realtime refetch, no polling. New files are focused (`team/landings/*`), not grown into existing giants. `any`-free, i18n union, no inline static styles. | **PASS** |

Additional gates: local gates `format:check`, `lint`, `test` (builds shared then vitest), and
`build` for `apps/web` **and** `apps/agent` (CI never builds the agent); new migration is
forward-only with `ROLLBACK.md` reverse steps and `npm run types:supabase` regen; pgTAP for
the new RPCs; `real-agent-check.mjs` extended so the `teamWorkspace` contract covers the new
routes. No production deploy/tag/release.

**Result: PASS.** One new backend surface (shared render persistence) is required by FR-007 and
is justified in Complexity Tracking; it is built on existing seams, not beside them.

## Project Structure

### Documentation (this feature)

```text
specs/004-team-landings-gallery/
├── plan.md                 # This file
├── research.md             # Phase 0: render-storage decision + reuse research
├── data-model.md           # Phase 1: entities, states, validation, invalidation rules
├── quickstart.md           # Phase 1: end-to-end validation guide
├── contracts/              # Phase 1: shared / Edge / agent / web contracts
│   ├── README.md
│   ├── reused-surfaces.md          # what is reused unchanged from 001/002/local previewer
│   ├── shared-landing-render.md    # @video-compressor/shared transport + release contract
│   ├── db-landing-renders.md       # migration tables + security-definer RPC signatures
│   ├── edge-drive-transfer.md      # drive-transfer render-serve + artifact-grant + sync cleanup
│   ├── agent-team-landing-gallery.md # agent /api/team/landings/* routes (teamWorkspace tool)
│   └── web-landings-gallery.md     # teamApi methods + gallery/viewer UI contract
└── tasks.md                # Phase 2 ($speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/shared/src/
├── team/
│   ├── transport.ts        # + LandingRender, RenderArtifactRef, gallery request/response, render states
│   ├── landing-gallery.ts  # NEW: viewer presets (device/colorScheme/zoom), gallery item model, guards
│   ├── analytics.ts        # + content-free landing-gallery view/open/render events
│   └── index.ts / types.ts # re-export the new contract
└── release.ts              # teamWorkspace tool contract covers the new agent routes

supabase/
├── migrations/
│   └── 20260810090000_team_landing_renders.sql   # NEW: landing_renders + artifact refs + RPCs
├── migrations/ROLLBACK.md                          # + reverse steps
└── functions/
    ├── drive-transfer/                             # serve cached render bytes; issue artifact-write grant
    └── catalog-sync/                               # tombstone render artifacts when source removed/changed

apps/agent/src/
├── landing-preview/renderer.ts                     # reused (shared render engine)
└── team-bridge/
    ├── landing-gallery.ts   # NEW: render landing → WebP segments → upload artifact → commit
    ├── preview.ts           # reused live-origin + screenshot fallback
    ├── preview-origin.ts    # reused sandbox/CSP/nav-guard
    └── routes.ts            # + /api/team/landings/* under the teamWorkspace ToolModule

apps/web/src/
├── team/landings/           # NEW surface
│   ├── LandingGallery.tsx           # grid of rendered thumbnails (US1)
│   ├── LandingGalleryTile.tsx       # one landing: thumbnail + name + state (ready/candidate/needs-agent/error)
│   ├── LandingFullView.tsx          # open-from-gallery preview + viewer controls (US2)
│   ├── LandingViewerControls.tsx    # device / colour-scheme / zoom presets (shared with local previewer model)
│   └── useTeamLandings.ts           # gallery state on useCatalogSearch + useTeamRealtime
├── team/workspace/WorkspaceShell.tsx # + "Landings" view in the content-first shell (FR-015)
├── team/preview/MaterialPreview.tsx  # reused single-landing preview (US2 opens into it)
├── landing-preview/LandingPreviewPage.tsx # + open a connected team space as a catalog (US3, FR-016)
├── api/team.ts / api/client.ts       # + typed gallery/render methods
├── analytics/events.ts / service.ts  # + landing-gallery events
├── i18n.ts                           # + en/uk keys
└── styles.css                        # + gallery/tile/full-view/controls styles

tests/
├── team-landing-gallery.test.tsx     # US1 listing/isolation/permission/empty
├── team-landing-fullview.test.tsx    # US2 open + viewer controls + unavailable states
├── team-landing-render-sharing.test.ts / .test.tsx  # US3 shared render, agent-required, invalidation
├── team-landing-render.test.ts       # agent render→upload→commit contract
├── team-security.test.ts             # extended: no leak, sandbox holds for gallery/renders
├── catalog-sync.test.ts              # extended: render-artifact tombstone/invalidation
└── i18n.test.ts / release.test.ts    # extended: keys + teamWorkspace contract coverage

supabase/tests/database/team-workspace.test.sql # extended: landing_renders RLS/ACL/definer/invalidation
```

**Structure Decision**: Monorepo, all four workspaces, but confined to established seams. The
new UI lives under `apps/web/src/team/landings/` (mirrors the `catalog/`, `preview/`,
`processing/` sibling pattern); the new backend is one forward-only migration plus additive
Edge/agent concerns under the existing `teamWorkspace` tool contract.

## Complexity Tracking

| Violation / added surface | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| New backend surface (a `landing_renders` table + RPCs + Drive artifact subtree), despite the "content is already built" framing | FR-007 / SC-003 require a render produced by one member to be viewable by another **without** the second member's agent — impossible without persisting the render somewhere team-shared. US1/US2 alone (agent-backed, ephemeral) cannot satisfy it. | **Agent-only, no persistence**: fails SC-003 (agent-less members see nothing). **Supabase Storage bucket**: new cloud-storage surface + bucket RLS/lifecycle to build, contradicts the spec's "no new cloud storage" assumption. **Postgres blob**: full-page screenshots are large; bloats the DB and the catalog realtime payloads. Drive-backed reuses the shared connection, `drive-transfer` byte path, and catalog-sync tombstones. |
| Render artifacts written into the user's connected Drive (hidden `.soty/landing-previews/`) | Keeps renders co-located with source, cleaned by the existing sync tombstone path, and served by the existing cloud byte path with zero new storage infra. | A dedicated store would need its own auth, RLS, retention, and cleanup; the hidden-subtree convention is self-cleaning and already within the connected root's scope. Mitigation: a single hidden namespace, documented in operations, excluded from the catalog listing. |
