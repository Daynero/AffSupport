# Implementation Plan: Team Workspace That Works

**Branch**: `011-team-workspace-rework` (Spec Kit feature directory; work continues on `main` — no
`before_plan` hook is configured and the release in flight must not be disturbed) | **Date**: 2026-08-27 |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-team-workspace-rework/spec.md`

## Summary

Team mode has every table, function and screen it needs and still does not work for the one
person who tries to use it. This plan does not add a parallel system; it reroutes the existing
one around the three things that are actually broken and removes the surfaces that were built
before they worked.

1. **Storage connection that survives** (US1, US4). Production requests the restricted
   `https://www.googleapis.com/auth/drive` scope through an OAuth app that was never verified,
   so every connection dies within seven days (`invalid_grant`) and only pre-listed test
   accounts can consent. The connection moves to the non-restricted `drive.file` scope with
   the owner choosing the root in the **Google Picker**. Spike R1 (research.md) decides whether
   a picked folder carries its descendants; per the 2026-08-27 clarification the release ships
   either way — single root if it does, a **selection set** of one or more picked folders if it
   does not — and the restricted-scope review is submitted in parallel without blocking
   anything. The existing `team_drive_connections`, credential vault, sync worker and change
   replay stay; they gain a `team_drive_selections` table, proactive refresh, and typed
   `needs_reauth` / `root_missing` states surfaced as one **storage chip**.
2. **The whole tree, from the index** (US1). A new `list_team_folder_tree` read returns every
   indexed folder with counts in one call (a few thousand rows at the 50k-material limit),
   the client builds the tree and breadcrumbs from it, and `list_team_materials` gains keyset
   paging plus a total. The provider is never on the click path: `catalog-sync` already
   walks the root with checkpoints and replays changes; it gains a per-folder "indexed"
   marker so a folder is openable the moment its page lands.
3. **Previews prepared ahead, without the local app** (US2). Google Drive already produces
   thumbnails for images and videos (`thumbnailLink`), and `drive-transfer` already relays and
   caches them in the private `team-thumbnail-cache` bucket — but only the Library and task
   attachments ever ask. The catalog rows gain `previewState` + a short-lived per-team
   **thumbnail session** so a grid of 200 rows costs one grant, not 200; a new
   `preview-warm` worker pre-fetches thumbnails into the bucket folder by folder as sync
   completes; landing archives reuse `team_landing_renders` with the first segment promoted to
   the tile and a background render claim loop on any paired agent that honours the power
   governor. Video playback keeps the existing range relay.
4. **One explorer** (US3). `apps/web/src/team/explorer/` replaces the Files / Landings /
   Library tabs: folder tree, content grid/list, preview pane, kind filters and search on one
   screen. `landings` and `library` become kind filters and redirect; Tasks and Members remain
   secondary; Settings folds into the space header. Every capability of the merged areas is
   mapped to an explorer location in `contracts/explorer-ui.md` so nothing is lost.
5. **Proof on real storage** (US5). `quickstart.md` runs the 010 "could not cover" list on the
   beta stack with a real OAuth test client and again on production, and records it.

Everything is built and verified **sequentially on a low-powered machine**: one build, one
suite, one check at a time (see Delivery constraints).

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true`, ESM `NodeNext` (`.js` specifiers); React 18
functional components; Deno TypeScript for Supabase Edge Functions; SQL (Postgres 15 /
Supabase); zsh/mjs scripts.

**Primary Dependencies**: React + Vite (`apps/web`), Supabase JS (RPC, Edge Functions, Realtime,
Storage), Fastify agent (`apps/agent`), `@video-compressor/shared`. **One new browser-side
external**: the Google Picker (`https://apis.google.com/js/api.js`, loaded on demand only on
the connect screen) — requires a CSP allowlist entry (Complexity Tracking). No new npm runtime
dependencies; no data-fetching library; routing stays hand-rolled.

**Storage**: Existing Supabase Postgres (`teams`, `team_drive_connections`, `team_materials`,
`team_landing_renders`, `team_operations`, `team_catalog_events`, …), Vault-held Google
credentials (`private.google_drive_credentials`), private Storage bucket
`team-thumbnail-cache`, Drive hidden namespace `.soty/landing-previews/…`. New: table
`team_drive_selections`, columns on `team_materials` (`folder_indexed_at`, `thumbnail_state`,
`thumbnail_version`), one `preview-warm` job queue reusing `team_operations`, three read RPCs,
two service RPCs. Forward-only migrations with `ROLLBACK.md` entries.

**Testing**: Vitest in `tests/` — PGlite for SQL (team-contract harness via
`scripts/generate-team-contract-sql.mjs`), handler-level tests for Edge Functions (pattern:
`tests/drive-connect.test.ts`), jsdom for the explorer (pattern: `tests/team-ux-*.test.tsx`),
`tests/support/lifecycle-drivers.ts` for agent claim loops. End-to-end: beta stack
(`npm run beta:up`) with the opt-in OAuth test client from `docs/BETA.md`; the real-agent check
`scripts/real-agent-check.mjs` for the render claim loop.

**Target Platform**: Browser (Cloudflare Pages build of `apps/web`), Supabase (migrations +
Edge Functions), local agent on macOS and Windows (render claim loop only).

**Project Type**: npm-workspaces monorepo web application + local agent + backend functions.

**Performance Goals**: indexed folder first screen < 1 s (SC-003) with the provider
unreachable; tree read ≤ 1 call, ≤ 250 ms server time at 5,000 folders; thumbnail grid of 200
rows ≤ 1 grant + ≤ 200 cached relay hits; cold preview first frame ≤ 2 s (SC-004); search first
page ≤ 1 s at 50,000 materials (existing `search_materials` benchmark holds).

**Constraints**: provider never on the click path; no file content outside the provider and
the space's own storage; thumbnail bytes served only through the authorising relay; power
limit honoured by every agent-side job; every migration reversible; the release in flight is
not touched (no version bump in this plan). Because `packages/shared` and `apps/agent`
change, **the production deploy of 011 is the next agent release** — a web-only deploy
would be refused by `verify-release --deploy` (research R8); until then verification is on
the beta stack and dev builds.

**Scale/Scope**: 50 members, 50,000 materials, ~5,000 folders per space; one space in
production today; 23 registered users. Screens: 1 new explorer (5 panes), 1 storage chip, 1
connect flow, 2 redirects; ~12 files removed.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
| --- | --- | --- |
| I. Type-safe contracts at the boundary | New types (`TeamFolderNode`, `TeamMaterialRow`, `ThumbnailSession`, `StorageHealth`, `TeamDriveSelection`) live in `packages/shared/src/team/` with guards; Picker payload, Drive `thumbnailLink`, RPC rows parsed as `unknown` → guard; no `as` on payloads | PASS |
| II. One source of truth for release/protocol | No version constants touched by this plan. `shared` and `agent` change, so the web deploy is coupled to the next agent release (bump under the release rules, `verify-release --deploy` enforces it); the `backgroundRender` capability additionally keeps old agents from being asked | PASS (see R8) |
| III. Security & least privilege | `team_drive_selections` gets RLS + narrow grants; all new SQL functions `security definer set search_path = ''`; thumbnail session is a purpose-bound, team-bound, 15-min token verified on every relay read, bytes never public; Picker access token is minted server-side from the Vault refresh token, lives in browser memory only, `drive.file` scope; CSP gains exactly `https://apis.google.com` for `script-src` and `connect-src` on the connect route, generated by `scripts/generate-csp-headers.mjs` (Complexity Tracking) | PASS with justification |
| IV. Child-process discipline | Render claim loop reuses `LandingPageRenderer` and the existing `TeamLandingRenderBridge`; no new spawns; governor pinning via the 008 power lever; cancellation on drain | PASS |
| V. HTTP API & error conventions | Agent: no new routes beyond the existing team-bridge module; Edge Functions: new actions return existing envelopes with machine codes (`SELECTION_UNREACHABLE`, `THUMBNAIL_SESSION_EXPIRED`, `ROOT_MISSING`) added to `TEAM_ERROR_CODES` | PASS |
| VI. Frontend composition | Explorer built from context idiom (`ExplorerProvider` + `useExplorer()`), typed `api/client.ts` wrappers, `TranslationKey` copy, `styles.css` classes on the token scale; no file over 400 lines (split panes); no `any` | PASS |
| Workflow gates | `npm run verify` after every step; `verify:release` before the beta run; new tests in `tests/`; migrations `YYYYMMDDHHMMSS_<slug>.sql` + `ROLLBACK.md` | PASS |

Post-design re-check (after Phase 1): unchanged — the data model adds one table and three
columns, the contracts add no new envelope shapes, and the only external is the Picker script
recorded below.

## Project Structure

### Documentation (this feature)

```text
specs/011-team-workspace-rework/
├── plan.md              # This file
├── research.md          # Phase 0 — R1–R10 decisions
├── data-model.md        # Phase 1 — entities, columns, states
├── quickstart.md        # Phase 1 — beta + production validation runs
├── contracts/
│   ├── backend-rpc.md       # SQL read/service functions
│   ├── edge-functions.md    # drive-connect / drive-transfer / preview-warm actions
│   ├── explorer-ui.md       # routes, panes, capability map from the merged areas
│   └── storage-health.md    # chip states and their sources
├── checklists/requirements.md
└── tasks.md             # Phase 2 — /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
packages/shared/src/team/
├── contract.ts           # + TeamDriveSelection, TeamFolderNode, StorageHealth, ThumbnailSession types/guards, materialKindOf(), TEAM_RECONCILIATION_INTERVAL_MS
├── transport.ts          # + TeamMaterialRow (summary + previewState/thumbnail), paging cursor
└── analytics.ts          # + team_storage_connected / team_index_completed / team_previews_ready / team_storage_attention

supabase/migrations/
├── 20260827HHMMSS_team_drive_selections.sql
├── 20260827HHMMSS_team_folder_tree_and_paging.sql
├── 20260827HHMMSS_team_thumbnail_state.sql
└── ROLLBACK.md           # reverse steps appended

supabase/functions/
├── drive-connect/        # scope → drive.file; picker-token action; selections add/remove; proactive refresh
├── drive-oauth-callback/ # unchanged flow, scope check updated
├── drive-transfer/       # + thumbnail session mint; /thumbnail accepts session; batch warm hook
├── preview-warm/         # NEW worker: fetch thumbnailLink → bucket per indexed folder
├── catalog-sync/         # + folder_indexed_at checkpoint; root rename/missing handling; enqueue warm
└── _shared/              # drive.ts (+ selections walk), errors.ts (+ codes), thumbnail-session.ts

apps/agent/src/team-bridge/
├── landing-gallery.ts    # + background render claim loop (governor-aware, drain-aware)
└── routes.ts             # unchanged surface; loop wired in module register/shutdown

apps/web/src/team/
├── explorer/             # NEW — ExplorerShell, ExplorerProvider, FolderTree, ContentGrid, ContentList,
│                         #        PreviewPane, KindFilterBar, ExplorerSearch, useFolderTree, useFolderPage,
│                         #        useThumbnailSession
├── storage/              # NEW — StorageChip, useStorageHealth, ConnectStorageFlow (Picker), SelectionList
├── routes.ts             # sections: explorer | tasks | members (+ redirects landings/library → explorer?kind=)
├── workspace/            # WorkspaceShell trimmed: header (name, switcher, chip, settings), secondary nav
├── catalog/ landings/ library/   # components kept are moved under explorer/ or deleted (see explorer-ui.md)
└── drive/                # DriveFolderBrowser deleted (Picker replaces it); DriveConnectionPanel → storage/

apps/web/src/api/client.ts   # + listFolderTree, listFolderPage, mintThumbnailSession, pickerToken, selections
scripts/generate-csp-headers.mjs   # + apis.google.com on the connect route
scripts/analytics/queries.ts       # team-workspace: + index/preview/attention counters (read-only)
docs/TEAM_WORKSPACE_OPERATIONS.md  # scope, selections, warm worker, chip states
docs/GOOGLE_OAUTH_VERIFICATION.md  # drive.file path + parallel restricted-scope packet

tests/
├── team-selections.test.ts, team-folder-tree.test.ts, team-thumbnail-session.test.ts   # PGlite / handler
├── preview-warm.test.ts, catalog-sync-indexed.test.ts, drive-connect-picker.test.ts    # Edge handlers
├── team-explorer-*.test.tsx (tree, grid, preview, filters, search, keyboard, narrow)   # jsdom
├── team-storage-chip.test.tsx, team-render-claim-loop.test.ts                            # jsdom / agent
└── team-explorer-capability-map.test.ts   # asserts every row of contracts/explorer-ui.md has a home
```

**Structure Decision**: web application inside the existing monorepo seams. New code goes in
two new web folders (`team/explorer/`, `team/storage/`), one new Edge Function
(`preview-warm`), and additive columns/tables; deletions are listed explicitly in
`contracts/explorer-ui.md` so the merge is auditable.

## Delivery constraints (owner's machine)

- Every task names the **single** gate command it ends with; never two builds or two suites
  at once. Order: `prettier --check <files>` → `eslint <files>` → the one relevant `vitest run
  <file>` → `tsc -b apps/web` (or agent build) → `npm run verify` only at phase ends.
- Check `uptime` before any build, suite, `beta:up` or packaging; do not start if the 1-minute
  load average exceeds the core count.
- The beta stack is started once per verification session and stopped with `beta:down`
  immediately after.
- `preview-warm` runs server-side; the only agent-side load is the render claim loop, which
  runs at most one render at a time at the lowest power setting and is off unless the space
  has pending landing renders.
- The release in flight is not touched: no version constants, no `stable.json`, no tags.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| External script on the browser origin (`https://apis.google.com/js/api.js`, Picker) — CSP `script-src`/`connect-src` widened on the connect route only | `drive.file` cannot list folders; the only way for the owner to pick a root under a non-restricted scope is Google's own chooser | Building our own chooser needs a listing scope, which is restricted — the very dependency D1 removes. Keeping `drive` scope needs the review that never happened |
| Short-lived Google access token in browser memory (Picker `oauthToken`) | The Picker authenticates with an access token; it is minted server-side from the Vault refresh token, scoped `drive.file`, ≤ 1 h, never persisted | Letting the browser run its own OAuth would create a second credential outside the Vault and a second consent |
| New Edge Function `preview-warm` instead of extending `catalog-sync` | Warming is bandwidth-bound and retryable independently of indexing; a failed thumbnail must not stall the index | Folding it into `catalog-sync` couples the index checkpoint to provider thumbnail availability, which is eventually consistent on Google's side |
| Agent change (render claim loop) inside a feature otherwise web+backend | Landing tiles need a render; only the agent can render; the existing on-demand path already needs it | A server-side renderer is a new runtime, browser and security surface — far larger than a claim loop on a bridge that exists |
