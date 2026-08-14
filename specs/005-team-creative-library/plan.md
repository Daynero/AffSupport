# Implementation Plan: Team Space / Creative Library

**Branch**: `005-team-creative-library` _(Spec Kit feature context; the working Git branch is
not changed because no branch hook is configured)_ | **Date**: 2026-08-14 | **Spec**:
[spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-team-creative-library/spec.md`

## Summary

Extend the existing team workspace into a lightweight Creative Library over the team's
connected Google Drive. The increment adds deterministic Finds/Library placement, resilient
bulk upload, local language/thumbnail enrichment, explicitly started shared processing with
per-operation leases, version-bound shared results, video transcript sidecars that move and
trash with their source, a separate task space with unlimited reference attachments, and
permission-on-demand Drive sharing. Human activity and Local Agent processing remain separate,
content-free contribution streams.

The implementation extends the existing shared contract, Supabase/Postgres authority, Drive
Edge boundary, local `team-bridge`, and React workspace. Google Drive remains the byte store;
Postgres stores authority, stable identities, placements, jobs, task references, preferences,
and audit/contribution facts. No production migration, deploy, package, tag, or release is part
of this workflow.

## Technical Context

**Language/Version**: TypeScript 5.9.x with `strict: true`, ESM/NodeNext and ES2022; React
19.2.x; Supabase Edge Runtime TypeScript; SQL on PostgreSQL 17. Node 22 is the validation
standard.

**Primary Dependencies**: Existing Vite 8, Fastify 5, `@supabase/supabase-js`, Supabase
Auth/Postgres/Vault/Realtime/Cron, Google Drive API v3, FFmpeg/ffprobe, whisper, Playwright,
and archive/landing-render tooling. No new runtime dependency or media binary is introduced.

**Storage**:

- Google Drive remains canonical for asset, transcript, translation, optimized-landing, and
  other result bytes under the connected root.
- Supabase Postgres stores structural placement, upload batches, version-bound processing
  requirements/results/leases, task records and reference attachments, share preferences,
  contribution records, and safe catalog projections.
- Supabase Vault continues to hold only shared Drive refresh tokens.
- The local agent uses `mkdtemp` workspaces and removes all temporary source, frame, text, and
  output files in `finally`.

**Testing**: Vitest for shared/web/agent/Edge boundary logic; local Supabase PostgreSQL 17 and
pgTAP for RLS, grants, definer functions, uniqueness, lease races, result acceptance, task
authorization, and privacy; mocked Drive for group sagas/sharing; real-agent fixtures for
language sampling, the 1-second video frame, processing, cancellation, and cleanup.

**Target Platform**: Existing Cloudflare Pages web app, managed Supabase backend, and packaged
macOS local agent. The UI stays responsive for desktop/tablet/mobile; drag-and-drop always has
keyboard-accessible search/action equivalents.

**Project Type**: Existing npm-workspaces web + local agent + shared package + Supabase
backend. No new workspace or service is created.

**Performance Goals**:

- each successfully uploaded item appears independently within 3 seconds of byte finalization;
- task/date pages return the first 50 rows and attachment summaries within 2 seconds for a
  10,000-task/100,000-attachment fixture;
- Process Library scan is paged and deterministic for 10,000 assets;
- a stopped processing lease becomes reclaimable within 2 minutes;
- task tiles reveal a useful cached image/landing/video representation or typed fallback
  without blocking the task list;
- video tiles seek to 1.0 seconds (or the final available frame for shorter media), never
  intentionally use frame zero when a 1-second frame exists.

**Constraints**:

- Drive bytes and hierarchy remain authoritative; attachments are references and never move
  or copy files;
- structural paths have at most `Stage / Offer / Language / Type`; folder ids are resolved
  server-side and every side effect re-checks live ancestry/capabilities;
- manual language always fences out a late automatic result;
- heavy work starts only after an explicit Process Library or per-asset action;
- one current original transcript per source version; translations are separate variants;
- source + current sidecars use a truthful group operation for move/trash/restore, with
  compensation/reconciliation after a partial provider failure;
- leases are operation-scoped, short-lived, heartbeat-renewed, and first-valid-result-wins;
- transcript bodies, filenames, paths, Drive URLs, grant/session identifiers, and provider
  bodies never enter Realtime, analytics, contribution rows, audit targets, or logs;
- task reads require `view`; create/update/attach require `edit`; search and attachments never
  reveal a hidden or foreign-team material;
- no fixed product cap on task attachments; APIs remain paged and accept bounded mutation
  batches repeatedly;
- Share uses current `edit` plus live Drive `canShare`; remembered approval skips only the
  prompt and never the current checks;
- no silent overwrite, permanent Drive delete, unbounded Edge buffering, polling, or new
  browser persistence for bearer capabilities.

**Scale/Scope**: 7 user stories; FR-001–FR-088 plus suffixed transcript/task refinements;
50 active members/team; at least 100 files per upload selection; 50,000 catalog assets;
10,000 Library assets per scan; 1,000 concurrent queued operations across several agents;
tasks with 1–100 attachments in the reference matrix and no semantic product maximum.

## Constitution Check

_GATE: evaluated before Phase 0 research and re-checked after Phase 1 design._

| Principle                          | Gate                                                                                                                                                                                                                                              | Post-design verdict |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **I. Type-safe contracts**         | New placement, batch, job/lease, result, transcript-variant, task, attachment, share and contribution payloads live in `@video-compressor/shared`. Every RPC/Edge/agent/drag payload enters as `unknown` and is narrowed without unchecked casts. | **PASS**            |
| **II. One source of truth**        | Shared enums, bounds and agent tool-contract additions are canonical. SQL lookup/check values are generated or parity-tested. `release.ts` changes only if the agent protocol surface is incompatible; no product version is bumped here.         | **PASS**            |
| **III. Security/least privilege**  | New tables force RLS and revoke broad grants. Every feature function is caller-checked or service-only `security definer`, uses `search_path=''`, fully qualified names and exact ACLs. Drive/Vault authority stays server-side.                  | **PASS**            |
| **IV. Resource orchestration**     | Language sampling, thumbnail extraction and distributed processing reuse the existing spawn/watchdog/cancel/SSE/temp-cleanup machinery. Downloads remain bounded Range transfers.                                                                 | **PASS**            |
| **V. HTTP/error conventions**      | Edge uses the existing structured team error union and idempotency keys; agent routes remain `ToolModule` routes with stable `{ error }` codes. Partial group state and stale/lease races are explicit codes, never human strings.                | **PASS**            |
| **VI. Frontend composition/state** | New Library/Tasks views compose through `WorkspaceShell`, typed API wrappers, TeamContext permissions, existing Realtime refetch and one Agent SSE hook. CSS classes/i18n are shared; drag has button/search parity and no polling is added.      | **PASS**            |

Additional gates: forward-only timestamped migrations and reverse notes; regenerated database
types; PG17 pgTAP; `format:check`, lint, complete tests, shared/web/agent builds, contract drift,
and targeted real-agent checks. No constitution violation or waiver is required.

## Project Structure

### Documentation (this feature)

```text
specs/005-team-creative-library/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── README.md
│   ├── library-and-bulk.md
│   ├── processing-and-sidecars.md
│   ├── tasks.md
│   └── sharing-and-contributions.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/shared/src/team/
├── creative-library.ts             # placement, batch, enrichment and share contracts
├── library-processing.ts           # requirement/result/lease/sidecar state machines
├── tasks.ts                        # task, progress, attachment and date-filter contracts
├── analytics.ts                    # separate content-free contribution events
├── transport.ts                    # Edge/agent discriminated payloads
└── index.ts                        # package-root exports

supabase/
├── migrations/
│   ├── 20260814100000_creative_library_foundation.sql
│   ├── 20260814101000_creative_library_actions.sql
│   └── 20260814102000_creative_library_security.sql
├── migrations/ROLLBACK.md
├── functions/
│   ├── _shared/library.ts           # structural path, sidecar group and provider adapters
│   ├── library-ops/                 # batch/placement/process scan+lease/share boundary
│   └── drive-ops/                   # group move/trash/restore + result finalize integration
└── tests/database/creative-library.test.sql

apps/agent/src/team-bridge/
├── library.ts                       # claim/heartbeat/delegate/finalize orchestration
├── language-detection.ts            # bounded video/landing local detection
├── thumbnail.ts                     # 1-second video/image lightweight artifact work
├── process.ts                       # existing tool delegation extended for job leases
└── routes.ts                        # registered team library routes

apps/web/src/team/
├── library/
│   ├── CreativeLibrary.tsx
│   ├── BulkUploadDialog.tsx
│   ├── LibraryAssetCard.tsx
│   ├── ProcessLibraryDialog.tsx
│   ├── VideoTextActions.tsx
│   └── useCreativeLibrary.ts
├── tasks/
│   ├── TaskSpace.tsx
│   ├── TaskEditor.tsx
│   ├── TaskCard.tsx
│   ├── TaskAttachmentPicker.tsx
│   ├── TaskAttachmentTile.tsx
│   ├── TaskDateFilter.tsx
│   └── useTasks.ts
├── workspace/WorkspaceShell.tsx
└── catalog/MaterialResults.tsx

apps/web/src/api/team.ts             # typed RPC/Edge wrappers
apps/web/src/i18n.ts                 # English/Ukrainian copy
apps/web/src/styles.css              # responsive Library/Tasks tiles and drag states
apps/web/src/analytics/              # content-free contribution emission

tests/
├── creative-library-contract.test.ts
├── creative-library-bulk.test.tsx
├── creative-library-processing.test.ts
├── creative-library-distribution.test.ts
├── creative-library-sidecars.test.ts
├── creative-library-tasks.test.tsx
├── creative-library-sharing.test.ts
├── creative-library-security.test.ts
└── creative-library-workspace.test.tsx
```

**Structure Decision**: Postgres remains relational authority; Drive remains byte/hierarchy
authority; Edge coordinates provider writes; the local agent owns bounded local media work;
the web composes permission-scoped Library and Tasks views. Pure task mutations stay in
caller-checked RPCs, while operations that touch Drive use `library-ops`/`drive-ops` sagas.
This extends the existing architecture without another service or top-level workspace.

## Complexity Tracking

No constitution violation requires justification. A durable job/lease table and a separate
task-attachment join are necessary domain state, not generic infrastructure: the former
prevents duplicate distributed results and the latter guarantees attachment references do
not masquerade as Drive moves or copies.
