# Implementation Plan: Командний медіапростір Wishly

**Branch**: `main` _(Spec Kit feature: `001-team-media-workspace`)_ | **Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-team-media-workspace/spec.md`

## Summary

Wishly gains a team media workspace in which authenticated users create teams, invite up to
50 active members, manage roles and per-member permission overrides, and connect one Google
Drive folder as shared storage. Members receive a permission-scoped catalog, search and
filters, safe previews, file operations, and a path from an existing Wishly tool back to a
separate derivative stored beside its source.

The v1 content editor is deliberately closed to complete UTF-8 `.txt` transcripts up to
1 MiB; `.srt` and `.vtt` remain preview/search inputs. A shared, versioned classifier is invoked by both Drive sync and
upload finalization; transcript text is fetched in bounded ranges, indexed at a UTF-8
boundary, and marked when truncated or invalid. Unsupported content uses download or a
separate `version_of` material rather than an implied overwrite. `edit` owns rename, move,
and supported content writes; `manage_metadata` alone owns GEO/language/offer/tags.

The shared domain lives in Supabase Postgres 17 with RLS. Google Drive remains the byte
store. Supabase Edge Functions form the integration/control layer: OAuth, server-side
permission checks, Drive metadata operations, bounded Range transfer, resumable-upload
session creation, invitation email, and bounded catalog-sync workers. Per-connection Drive
refresh tokens live in Supabase Vault; clients never receive a Google access/refresh token.
Large uploads go directly to a Drive resumable session and large downloads are fetched by
the local agent in bounded Range chunks, so an Edge invocation never buffers or owns a
multi-gigabyte transfer. The local agent gains a thin `team-bridge` module but reuses the
existing compressor, transcription, landing, cancellation, SSE, and cleanup machinery.

## Technical Context

**Language/Version**: TypeScript 5.9.3, `strict: true`, ESM (`NodeNext`, ES2022); React
19.2.7; Supabase Edge Runtime (Deno-compatible TypeScript); SQL on PostgreSQL 17 (linked
project reports 17.6). Node `^20.19.0 || >=22.12.0`; project validation standard is Node 22.

**Primary Dependencies**: Vite 8.1.5, Fastify 5.10.0, `@supabase/supabase-js` 2.110.7,
Supabase Auth/Postgres/Vault/Realtime/Cron, Google Drive API v3 + OAuth 2.0, and Resend's
HTTP API for invitation delivery. Existing FFmpeg, whisper, Playwright, and archive tooling
are reused. No new client data-fetching library or media binary is introduced.

**Storage**:

- Supabase Postgres: teams, active/history-aware memberships, invitations, effective-role
  inputs, material catalog/metadata, provenance, operations, transfer grants, sync state,
  and append-only audit.
- Supabase Vault: one encrypted Drive refresh token per active connection; only a
  service-only credential accessor may read plaintext.
- Google Drive: source and derivative file bytes under the connected root.
- Local agent temporary directories: bounded transfer/preview/processing copies, always
  removed in `finally`.

**Testing**: Vitest for shared/web/agent logic; PGlite only for pure deterministic SQL/query
logic; local Supabase + pgTAP for Auth roles, RLS, grants, Vault references, functions,
Realtime publication, and ownership concurrency; mocked Google/Resend boundaries; real
agent integration for Range transfer, cancellation, and cleanup. TypeScript tests remain in
`tests/*.test.ts(x)`; database tests follow `supabase/tests/database/*.test.sql`.

**Target Platform**: Cloudflare Pages web app; managed Supabase Postgres/Edge; packaged
macOS local agent. No production deploy/release is part of this planning phase.

**Project Type**: Existing npm-workspaces monorepo (web + local agent + shared contract +
Supabase backend). No new top-level workspace.

**Performance Goals**: permission changes affect the next action within 10 s (SC-003).
SC-004 is an application-level benchmark: after 20 warmups, each of three runs measures 100
searches plus 100 filter changes against a deterministic 50,000-material fixture and
requires both overall and subgroup p95 typed-first-page latency below 2 s; `EXPLAIN ANALYZE`
is diagnostic, not the metric. The reference harness uses local Supabase/PostgreSQL 17 and
Node 22 on dedicated 4 vCPU/8 GiB/SSD with a fixed fixture/query-manifest hash and no other
build/test load. SC-006 measures 20 cold/warm starts in each of five preview categories at
50/10 Mbps, 50 ms RTT, and 0% loss, requiring at least 95/100 useful starts within 3 s and a
typed wait/error for every remainder without false readiness. Initial catalog scans,
transcript ingestion, and change feeds are resumable, paged jobs.

**Constraints**:

- one active Drive root and shared OAuth connection per team;
- all Drive mutations re-check Wishly permission, current per-item Drive `capabilities`,
  and live ancestry under the root; cached catalog parents/capabilities are not authority;
- broad `drive` scope is a restricted scope and production launch is gated on Google OAuth
  verification/security assessment; `DRIVE_OAUTH_MODE` is the closed enum
  `disabled|testing|verified`, defaults to `disabled`, permits `testing` only outside
  production, and permits a production OAuth start only as `verified`; rejected starts use
  stable code `OAUTH_APPROVAL_REQUIRED`; the broad server token is never passed to Picker
  or the browser;
- production detection combines normalized `WISHLY_SITE_URL`, OAuth transaction/request
  origin, and canonical `PRODUCTION_SITE_ORIGIN` from `release.ts`; any production signal
  wins. The gate runs before transaction creation, provider exchange, reconnect/root
  replacement, and production credential refresh, with zero OAuth/Vault/connection side
  effects on rejection;
- Edge limits (256 MB memory, 2 s CPU, 150/400 s wall clock) require bounded workers,
  streaming without buffering, resumable uploads, and chunked Range downloads;
- per-request Range chunks are capped at 32 MiB; browser-only full download is capped at
  100 MiB; larger downloads/processing use the agent, whose existing 100 GiB intake ceiling
  and per-tool limits remain authoritative and are shown before start;
- no silent overwrite; Drive trash, not permanent delete; no secret/session URI/ticket in
  logs or tracked files; no shortcut target is dereferenced unless it independently proves
  ancestry under the root;
- the canonical category classifier uses recognized explicit MIME first, extension fallback
  only for absent/generic/unrecognized MIME, and bounded safe inspection only to promote an archive to
  a landing package; transcript ingestion accepts UTF-8 BOM, indexes at most 1 MiB on a
  code-point boundary, records truncation/encoding/source-version state, and never publishes
  transcript text to Realtime or analytics.

**Scale/Scope**: 5 user stories, FR-001…FR-044 (+FR-021a), up to 50 active members and
50,000 catalog rows per team. Billing, guest links, other storage providers, and new media
engines remain out of scope.

## Constitution Check

_GATE: evaluated before research and re-checked against the Phase 1 design below._

| Principle                                    | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Post-design verdict |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **I. Type-safe contracts**                   | Team roles, permissions, states, errors, transfer limits, RPC/Edge/agent payloads, and analytics events are exported from the package root of `@video-compressor/shared`. Every Supabase/Google/Resend/transfer payload enters as `unknown` and is narrowed to a discriminated result; internal ESM imports use `.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **PASS**            |
| **II. One source of truth**                  | Shared constants are canonical. `generate:team-contract` is exactly `npm run build -w @video-compressor/shared && node scripts/generate-team-contract-sql.mjs`; every check that consumes the committed shared `dist` performs the same rebuild first. A process-level stale-`dist` fixture proves `--check` cannot return a false green. The generator snapshots role defaults, permissions, invite TTL, vocab, category/editor rules, limits, and contract version into migration SQL. The new agent bridge gets a `teamWorkspace` entry in `release.ts`; `AGENT_API_VERSION` changes only if compatibility is broken. Existing `latest` web dependencies are pinned to lockfile versions before the first web change.                                                                                                                                                   | **PASS**            |
| **III. Security/least privilege**            | Every new public **and private** table has RLS and narrow/no client grants; private schemas are absent from the Data API. Every feature SQL function—including caller reads/actions, policy/trigger helpers, and service-only functions—is `security definer`, sets `search_path=''`, and schema-qualifies every object. Caller RPCs derive identity only from `auth.uid()`, reject null/inactive/non-member callers, and apply explicit permission/team predicates before sensitive reads; no caller-supplied actor is authoritative. Function creation revokes default execute and regrants only `authenticated` or `service_role` as intended. User Edge calls authorize through a caller-scoped gate before service access. OAuth callback and cron use separate one-time/custom-secret modes. Refresh/transfer secrets remain Vault-backed or hashed/scoped/expiring. | **PASS**            |
| **IV. Child-process/resource orchestration** | `team-bridge` adds transport orchestration, not a new spawn implementation. Existing `shell:false`, bounded stderr, watchdog/cancel, `mkdtemp`, `finally` cleanup, and multipart drain rules remain. Cloud bytes are streamed to disk in bounded chunks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PASS**            |
| **V. HTTP/error conventions**                | Agent routes join `ToolModule`; success returns typed state and errors use stable machine codes. Edge endpoints use the same stable-code discipline with deliberate 400/401/403/404/409/413/415/422/429/503 statuses and idempotency keys. OAuth redirects are the documented exception to JSON responses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **PASS**            |
| **VI. Frontend composition/state**           | Active team/effective permissions use a throwing context hook plus test override. Supabase calls live in typed wrappers; agent calls extend the existing client. Local tool progress stays on an extracted shared SSE reconnect hook; cloud operation/catalog changes use RLS-filtered Supabase Postgres Changes and refetch authoritative rows. No polling, prop-drilled `t`, inline static styles, or new `any` in `src`.                                                                                                                                                                                                                                                                                                                                                                                                                                                | **PASS**            |

Additional gates: migrations are forward-only `YYYYMMDDHHMMSS_<slug>.sql`, rollback notes
extend `supabase/migrations/ROLLBACK.md`, DB types are regenerated, `db.major_version = 17`,
and local gates are `format:check`, `lint`, `test`, relevant builds, and `test:db`.

**Result: PASS after Phase 1 design; no unresolved `NEEDS CLARIFICATION` and no unjustified
constitution violation.**

## Project Structure

### Documentation (this feature)

```text
specs/001-team-media-workspace/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── README.md
│   ├── teams-and-members.md
│   ├── drive-storage.md
│   ├── catalog-and-search.md
│   ├── preview-and-processing.md
│   └── db-functions.md
├── checklists/requirements.md
└── tasks.md                         # dependency-ordered implementation graph
```

### Source Code (repository root)

```text
packages/shared/src/
├── team/                            # roles, states, guards, payloads, limits, vocab
│   ├── contract.ts
│   ├── transport.ts
│   ├── analytics.ts
│   ├── material-category.ts         # canonical versioned classifier
│   ├── transcript.ts                # UTF-8/editor/ingestion rules
│   └── index.ts
├── types.ts                         # re-exports team contract from package root
└── release.ts                       # teamWorkspace tool contract / compatibility

scripts/
└── generate-team-contract-sql.mjs   # deterministic shared → SQL snapshot generator

supabase/
├── config.toml                      # PG17; explicit callback/cron JWT modes
├── migrations/
│   ├── 20260801090000_team_contract_seed.sql
│   ├── 20260801091000_teams_members_invitations.sql
│   ├── 20260801092000_drive_vault_catalog.sql
│   ├── 20260801093000_team_operations_audit.sql
│   ├── 20260801094000_team_security_foundation.sql
│   ├── 20260801095000_team_invitation_drive_actions.sql
│   ├── 20260801100000_team_membership_actions.sql
│   ├── 20260801101000_team_catalog_search.sql
│   └── 20260801102000_team_transfer_operations.sql
├── migrations/ROLLBACK.md
├── functions/
│   ├── _shared/
│   │   ├── auth.ts
│   │   ├── cors.ts
│   │   ├── validation.ts
│   │   ├── errors.ts
│   │   ├── credentials.ts
│   │   ├── drive.ts
│   │   └── operations.ts
│   ├── team-invitations/            # create/resend + Resend delivery
│   ├── drive-connect/               # authenticated start/folder browser/status
│   ├── drive-oauth-callback/        # public redirect, one-time state + PKCE
│   ├── drive-ops/                   # metadata mutations + resumable session init/finalize
│   ├── drive-transfer/              # scoped Range/preview/agent transfer gateway
│   └── catalog-sync/                # named-secret, bounded durable queue consumer
├── tests/database/team-workspace.test.sql
└── functions/delete-account/index.ts # owner transfer-before-delete guard

apps/web/src/
├── team/
│   ├── TeamContext.tsx
│   ├── TeamWorkspacePage.tsx
│   ├── members/
│   ├── drive/
│   ├── catalog/
│   ├── preview/
│   └── processing/
├── api/team.ts                      # typed Supabase RPC/Edge wrappers
├── analytics/events.ts              # typed team success-metric events
└── ProtectedWishly.tsx              # actual team-workspace route/provider integration

apps/agent/src/
├── team-bridge/                     # scoped transfer + existing tool adapters
│   ├── index.ts
│   ├── routes.ts
│   ├── transfer.ts
│   ├── preview.ts
│   ├── preview-origin.ts
│   ├── process.ts
│   └── events.ts
└── server/tools.ts                  # registers teamWorkspace ToolModule

scripts/analytics/                   # team activation/adoption aggregate query/CLI support

tests/
├── team-contract.test.ts
├── team-invitations.test.ts
├── drive-connect.test.ts
├── team-members.test.tsx
├── delete-account-team.test.ts
├── drive-ops-guard.test.ts
├── drive-transfer.test.ts
├── material-category.test.ts
├── transcript-ingestion.test.ts
├── catalog-search.test.ts
├── catalog-benchmark.test.ts
├── catalog-sync.test.ts
├── team-catalog.test.tsx
├── team-preview-sandbox.test.tsx
├── team-preview-ui.test.tsx
├── team-bridge.test.ts
├── team-file-operations.test.tsx
├── transcription-modal.test.tsx     # existing read-only modal regression
├── team-workspace.test.tsx
├── team-security.test.ts
├── analytics-queries.test.ts
├── analytics-cli.test.ts
├── i18n.test.ts
└── release.test.ts
```

**Structure Decision**: Postgres owns shared authority and searchable metadata; Edge
Functions own bounded third-party integration; the existing local agent owns local file and
media work; the web app composes both through current auth/API/routing seams; shared owns
the protocol. Supabase Realtime is used only for cloud rows and existing Fastify SSE only
for local tool progress, so neither transport impersonates the other.

## Complexity Tracking

No constitution violation needs a waiver. Google restricted-scope verification, Vault,
bounded transfer grants, and a durable sync queue are required by the specified shared
Drive model; each replaces a less safe implicit assumption in the original plan rather than
adding an optional architectural layer.
