# Implementation Plan: Re-stitch defaults and prepared materials in the team space

**Branch**: `011-team-workspace-rework` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/015-team-restitch-defaults/spec.md`

## Summary

Give a space one saved answer for re-stitching, and turn re-stitching a material into one
choice on its download action. Behind it, cache the two things that make a re-stitch slow and
that depend only on a file's own bytes — the keyframe index and the screen detection — so a
delivery is transfer plus about four seconds, whatever the material's length.

Nothing about what a re-stitch _is_ changes: feature 014's tool does the work, the body is
copied and never re-encoded. What is new is where the settings live (the space, not a dialog),
what is remembered (per material, in Supabase), and one new place on the drive to keep shared
working material.

Three insertion points, no new page and no new agent module:

1. **Supabase** — one settings table, one preparation table, one working-folder record, all
   reached through `security definer` RPCs; one new `drive-ops` action that creates and
   re-finds the space's folder by an `appProperties` marker rather than by name.
2. **Agent** — the existing `team-bridge` download route gains a `restitch` delegate and an
   optional prepared record; one new route inspects materials in bulk.
3. **Web** — a Re-stitching section in the space settings built from the stitcher's own
   controls, a two-way download choice on video rows, and a toast that opens those settings
   over the current view.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict`, ESM `NodeNext` (internal imports carry `.js`).
Node for the agent; React 18 + Vite for the web; PostgreSQL functions for the Supabase half.

**Primary Dependencies**: Fastify (agent HTTP), FFmpeg/FFprobe through the existing spawn seam,
Supabase (Postgres, RLS, edge functions), Google Drive through the existing `drive-ops`
function. No new runtime dependency.

**Storage**: three new tables in `public` (`team_restitch_defaults`,
`team_material_restitch_prep`, `team_workspace_folders`); the agent's existing on-disk caches
(`PreparedBodyCache`, the silence banks) are reused unchanged; the space's download folder is
remembered in the browser's own storage.

**Testing**: Vitest for agent, shared and web; `supabase test db` for RLS and the RPCs; the
by-hand run in [quickstart.md](./quickstart.md) for the parts that need a real drive.

**Target Platform**: macOS and Windows agents paired to the web app; the space itself is the
existing Cloudflare-hosted web app.

**Project Type**: monorepo — local agent + web app + shared contract + Supabase.

**Performance Goals**: a prepared two-minute material delivered within 10 s end to end
(SC-001); the local half — source in hand to finished file — under 5 s for any length
(research D10); preparation of one material costs one inspection (6.7–13.9 s measured) and is
paid once.

**Constraints**: the ten-second budget includes a network transfer this feature does not
control, so the testable claim is stated on the local half. Preparation must survive a change
of photos or hold length (FR-006). Nothing may modify a member's own files (FR-024, SC-008).

**Scale/Scope**: a space of tens to low hundreds of videos; one preparation record per
material at a few hundred bytes; one settings row per space.

## Constitution Check

_GATE: passed before Phase 0, re-checked after Phase 1._

| Principle                                                  | How this feature satisfies it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I. Type-safe contracts, validated at the boundary**      | Three new shared types (`TeamRestitchDefaults`, `MaterialRestitchPrep`, `TeamRestitchPrepareProgress`), each with a `{ ok; value } \| { ok: false; error }` guard. `source_profile` coming back out of Postgres is parsed with the existing `parseSourceProfile`, never cast. No new numeric bound is invented: the hold length reuses `clampStitchEndDuration`, the operation/fit/duration modes are existing unions.                                                                                                               |
| **II. One source of truth for the release contract**       | `stitcher` is already in `AGENT_TOOL_CONTRACTS`, so the web gates the new choice through the live `toolContractCompatible` check and nothing else. `WEB_TOOL_REQUIREMENTS` is **not** touched during development: it is compared byte-for-byte with the signed manifest, so an early entry would fail `verify-release.mjs` — the gate this principle requires to pass — for the whole feature. The map changes in the release that ships the agent contract, and not before. No version or URL is written anywhere but `release.ts`. |
| **III. Security and least privilege**                      | Every new table: RLS on, `revoke all`, column-scoped grants, access through `security definer` functions with `set search_path = ''`. Writing the defaults needs `manage_metadata`; writing a preparation record needs `process`; reading needs membership. The new `drive-ops` action runs the same authorization the existing actions do. No secret enters a tracked file.                                                                                                                                                         |
| **IV. Disciplined child-process & resource orchestration** | Preparation and delivery run through the existing spawn seam and the power governor; no new spawn site. Temp work uses `mkdtemp` + `try/finally`. Cancellation holds the live child and is addressed by `operationId`, as the bridge already does.                                                                                                                                                                                                                                                                                   |
| **V. Consistent HTTP API & error conventions**             | The agent surface is two changes inside `team-bridge`, keeping its module shape. Errors are machine codes (`RESTITCH_NO_SCREENS`, `STITCH_SOURCE_UNSUPPORTED`, `PATH_NOT_GRANTED`), never sentences; statuses follow the existing table (400/403/409/415/503, 202 for the async prepare).                                                                                                                                                                                                                                            |
| **VI. Frontend composition & state discipline**            | No new page. The settings section mounts the stitcher's existing controls; the row menu gains one choice; the dialog already exists. Agent calls go through the typed wrappers in `api/client.ts`, Supabase through `getSupabaseClient()` with `{ data, error }` handled. Progress arrives on the bridge's existing event channel — no polling. Telemetry goes through the typed `analytics.track` union.                                                                                                                            |

**Result: pass, with nothing to justify in Complexity Tracking.** Two things worth naming as
deliberate rather than accidental:

- **A new `drive-ops` action.** The function has no folder-creating action today. This adds
  exactly one, on the existing authorization path, because FR-016 cannot be met without it.
- **Three tables rather than one.** They have different owners, different write permissions and
  different lifetimes (a setting the owner changes, a fact about a file, a pointer to a
  folder). Collapsing them into one JSON blob would put a `process`-level write and a
  `manage_metadata`-level write behind the same row.

## Project Structure

### Documentation (this feature)

```text
specs/015-team-restitch-defaults/
├── plan.md              # This file
├── research.md          # Phase 0 — the ten decisions, with the measurements
├── data-model.md        # Phase 1 — three stored shapes, two transient
├── quickstart.md        # Phase 1 — the by-hand proof
├── contracts/
│   ├── supabase-rpc.md  # three RPCs + the drive-ops action
│   ├── agent-http.md    # the widened download route + the prepare route
│   └── web-ui.md        # where it appears and what it says
└── tasks.md             # Phase 2 — not created by /speckit-plan
```

### Source code

```text
packages/shared/src/team/
└── restitch.ts                     # NEW — the three types and their guards

supabase/migrations/
└── 2026090XXXXXXX_team_restitch_defaults.sql   # NEW — 3 tables, RLS, 4 RPCs
supabase/functions/drive-ops/
└── index.ts                        # + ensure_workspace_folder
supabase/tests/database/
└── team-restitch.test.sql          # NEW — RLS and permission proofs

apps/agent/src/team-bridge/
├── download.ts                     # + the 'restitch' delegate, + destination passthrough
├── restitch-prepare.ts             # NEW — bulk inspection, one at a time
└── routes.ts                       # + POST /api/team/restitch/prepare (+ cancel)
apps/agent/src/stitcher/
└── plan.ts, probe.ts               # reused as-is; a prepared record short-circuits both

apps/web/src/team/
├── workspace/RestitchDefaultsSection.tsx   # NEW — the settings section
├── workspace/SpaceSettings.tsx             # + mount it
├── catalog/MaterialRowMenu.tsx             # + download choice on videos
├── explorer/RowActions.tsx                 # + wire the choice through
└── restitch/                               # NEW — the delivery hook and its toast
apps/web/src/api/
├── client.ts                       # + the widened download call, + prepare
└── team.ts                         # + the four RPC wrappers

tests/
├── team-restitch-defaults.test.ts  # NEW — the settings contract and its refusals
├── team-restitch-delivery.test.ts  # NEW — the delivery path, prepared and not
└── team-restitch-prepare.test.ts   # NEW — the prepare run, cancellation, invalidation
```

**Structure Decision**: the monorepo's existing seams, unchanged. The only genuinely new
directories are `apps/web/src/team/restitch/` (the delivery hook, kept out of the row menu so
the menu stays a menu) and one new shared module. Everything else is an addition to a file that
already owns that concern — which is what keeps this feature from growing a fourth place where
"how a screen is held" is decided.

## Phase 0 — Research

Complete: [research.md](./research.md). Ten decisions, each with what was rejected and why.
The one the owner asked to be told about — whether preparation is worth building — is answered
with the measured breakdown: inspection is 6.7–13.9 s per material and the silence bank
10.7–19 s once, both cacheable; the screens are ~1.4 s and are knowingly left alone.

No `NEEDS CLARIFICATION` remained after Phase 0.

## Phase 1 — Design & Contracts

Complete: [data-model.md](./data-model.md), [contracts/](./contracts/),
[quickstart.md](./quickstart.md).

**Post-design constitution re-check: pass.** The design added no `any`, no new spawn site, no
new response envelope, and no table without RLS. The one thing the re-check changed: the agent
does **not** write to Supabase from the bridge (it never has) — the prepare route reports what
it found on the event channel and the web layer stores it, which keeps the agent's outward
surface exactly as narrow as it is today.

## Risks

| Risk                                                                          | Handling                                                                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The transfer, not the stitching, breaks the ten-second promise on a slow link | SC-002 is written against the local half; the delivery reports its phases separately so a slow transfer is visibly a transfer, not a stall    |
| A member's agent lacks an image the space's defaults name                     | the run draws from the remaining enabled images and says which it could not use; the defaults are ids, not content (research D5)              |
| Two members prepare the same material at once                                 | the preparation write is an upsert keyed by material; a record written for a stale `drive_version` is ignored on read rather than conflicting |
| The drive folder is deleted between two runs                                  | resolution is id → marker search → create, so the next run recreates it and nothing else notices                                              |
| The prepared body cache grows                                                 | already bounded by the existing LRU ceiling; nothing here raises it                                                                           |
