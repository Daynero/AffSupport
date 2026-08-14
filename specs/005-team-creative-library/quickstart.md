# Quickstart & Validation: Team Space / Creative Library

Runnable validation guide for [data-model.md](./data-model.md) and [contracts/](./contracts/).
Use only isolated local/linked development resources. Do not deploy production, push a
production migration, change a release version, package, tag or publish from this workflow.

## Prerequisites

- Node 22, npm install complete, Docker-compatible runtime and Supabase CLI.
- Local Supabase reset to PostgreSQL 17 with feature 001/004 migrations present.
- Two or more test Soty users and isolated My Drive/Shared Drive roots.
- A compatible local agent with FFmpeg/ffprobe, whisper and landing preview tooling.
- Fixtures: 100+ mixed uploads; video at <1 s and >3 s with distinct frame zero/1 s; clear,
  silent and multilingual media; images; valid/corrupt landings; duplicate names; hidden and
  capability-restricted materials.
- Test-only Edge environment with existing Drive/Vault/catalog configuration and
  `DRIVE_OAUTH_MODE=testing`. No provider token belongs in a tracked file.

## Local gates

```bash
npx supabase start
npx supabase db reset
npm run generate:team-contract -- --check
npm run format:check
npm run lint
npm test
npm run test:team
npm run test:db
npm run build -w @video-compressor/web
npm run build -w @video-compressor/agent
```

Run targeted work first through the test files named below, then the complete gates.

## V1 — Contract, schema and privacy baseline

1. Build shared and prove placement, enrichment, requirement/attempt/result, task/progress,
   share and contribution enums/limits parse unknown input and match SQL checks.
2. Inventory every new function: definer, empty search path, exact ACL, fully-qualified
   behavior, no public/anon leakage.
3. Prove every new table forces RLS; authenticated cannot read private folder, lease, group
   intent or secret columns.
4. Exercise null/spoofed/removed/inactive/foreign-team callers and search-path shadowing.
5. Recursively inspect logs/errors/audit/Realtime/contribution/analytics outputs for forbidden
   content, names, paths, provider ids/URLs and capabilities.

**Pass**: contract drift is deterministic; all denials have zero Drive/Postgres mutation and
no hidden row/count/attachment/result hint.

## V2 — Bulk upload and canonical placement (US1)

1. Select at least 100 mixed files, set Finds/Offer/GEO once and choose Auto language.
2. Interrupt/resume several upload sessions; make one item fail; verify successful items
   appear independently and batch state is partial, not false success.
3. Repeat batch/item idempotency keys; verify one operation/material per item.
4. Upload names that normalize/casefold equally and race canonical folder ensure; verify one
   Stage/Offer/Language/Type folder mapping without silent replace.
5. Open Drive directly and locate the same stable files through the four-level path.
6. Supply a manual language and prove no auto job can overwrite it.

**Pass**: every successful item has one physical file, one stable material and truthful
per-item state; no completed item waits for the rest of the batch.

## V3 — Finds/Library, local enrichment and structural groups (US2)

1. Move five of twenty Finds to Library, return one, and inspect exact Drive parents: no
   copy or second logical asset.
2. Change Offer/Language/Type and verify task/result/provenance references survive.
3. Detect clear landing/video language locally; use silence then a later sample; force low
   confidence and verify Unknown.
4. Commit a manual language during running auto detection; the late commit is stale.
5. Confirm asset visibility while language/thumbnail/landing preview remains pending.
6. Force a provider failure halfway through source+sidecar structural move; verify
   `reconciling`, safe retry/compensation and no false target state.

**Pass**: successful moves converge as one group, manual decisions always win and heavy
processing never starts from upload alone.

## V4 — Process Library scan and shared results (US3)

1. Seed video without transcript, video with current transcript, landing without optimization
   and current optimized landing.
2. Scan and compare exact missing counts; verify no agent claim or heavy process before
   confirmation.
3. Run, then scan three more times without source changes: current results are never queued
   or duplicated.
4. Change source bytes/version and verify dependent results become stale while history stays.
5. Use interface language equal to original and verify no duplicate translation artifact.
6. Open current results as a teammate without a local agent.

**Pass**: one current result per source-version/kind/variant; unchanged repeated scans are
idempotent and ready results are team-visible.

## V5 — Distributed leases and first result wins (US4)

1. Start three users/agents against 1,000 requirements; verify different operations claim in
   parallel and unrelated operations for one asset are not globally locked.
2. Heartbeat one operation; ensure only its lease extends.
3. Pause/shutdown/crash one agent and verify all its unrenewed attempts are reclaimable within
   two minutes.
4. Race two controlled candidate finalizations. First valid candidate becomes current;
   second is `skipped/already_completed` and cannot overwrite it.
5. Revoke permission/change source before range, session and finalize steps; each next step
   fails safely.
6. Cancel during download/process/upload and verify state, resumability rules and temp cleanup.

**Pass**: every requirement has at most one accepted result and no crashed agent leaves a
permanent lease.

## V6 — Transcript sidecar lifecycle and video card actions (US3)

1. Transcribe a video; verify one adjacent UTF-8 Drive document, current version-bound
   result/provenance and bounded catalog cache.
2. Open video card: View Text reads cached text, Copy copies selected original/translation,
   and neither starts scan/claim/process.
3. For missing/stale text, verify Transcribe appears and Copy is absent.
4. Move the video and confirm every current transcript/translation sidecar moves with it while
   cache remains current.
5. Trash and restore the video; verify the current group converges together.
6. Force a partial provider failure and verify explicit reconciliation instead of success.
7. Change bytes; prior cache becomes stale and cannot be opened as current.

**Pass**: one current original transcript per source version; 100% group actions converge or
remain truthfully reconciling.

## V7 — Separate task space, multi-attachments and date filters (US5)

1. Create a task from a video card; verify it opens immediately with that material attached.
2. Create an empty task, attach several results through permission-filtered search, then drag
   100 selected visible assets from the left tree in repeated bounded batches.
3. Reattach duplicates and include a foreign/hidden id: valid unique rows remain, duplicates
   are idempotent and denied ids reveal no metadata.
4. Compare Drive before/after: no attachment changed bytes, parent, metadata or file count.
5. Verify image, cached landing and video tiles. For a >3 s fixture with distinct frame zero,
   wait for `seeked` and prove the tile targets 1.0 s; for <1 s use its final instant.
6. Move/rename/trash one attachment: reference survives; trashed tile is unavailable and task
   remains.
7. Set max=9/value=6 manually, move status to done and back: value remains 6. For an untouched
   task, done sets value=max. Lower max below value without explicit valid value: rejected.
8. Remove assignee: task remains with snapshot/unassigned state.
9. Seed tasks across DST/midnight boundaries; verify local date picker, Today, Yesterday and
   All Time use exact half-open UTC bounds and show the active filter.

**Pass**: no semantic attachment cap, no duplicates or provider mutation, no frame-zero false
preview, and progress/date behavior matches the contract.

## V8 — Quick Share (US6)

1. Copy an already public exact Drive item: one current URL, no permission mutation.
2. Copy restricted item without approval: prompt, no provider change.
3. Approve one item and remember for the team; verify only that item receives Anyone-reader,
   exact current URL is copied and preference is caller+team scoped.
4. Copy a second restricted item: prompt may be skipped, but current `edit`, ancestry and
   `canShare` are still checked.
5. Revoke capability, retry remembered action and verify truthful failure/no copied state.
6. Reset preference; ensure no unselected file/folder/Library permission changed.

**Pass**: every permission change is exact-item and explicit/currently authorized.

## V9 — Separate contributions and workspace integration (US7)

1. Complete a Local Agent transcription and human upload/Find selection/task completion.
2. Read owner/admin aggregates: Local Processing and Human Activity remain separate; no
   combined score or ranking.
3. Verify a non-admin cannot read team-wide contribution aggregates.
4. Navigate Workspace Library/Tasks/Settings on desktop/tablet/mobile; keyboard-create,
   search attach and drag alternative remain available; Realtime reconnect refetches
   authoritative data and removed members exit.

**Pass**: contribution meaning/privacy is correct and all views compose without polling or
permission leakage.

## Planned automated coverage

| Test                                                | Primary proof                                   |
| --------------------------------------------------- | ----------------------------------------------- |
| `tests/creative-library-contract.test.ts`           | shared parsing, bounds, SQL parity              |
| `supabase/tests/database/creative-library.test.sql` | RLS/ACL/functions/jobs/tasks/races              |
| `tests/creative-library-bulk.test.tsx`              | 100-item batch, progress, partial/idempotent UX |
| `tests/creative-library-processing.test.ts`         | scan/current/stale result semantics             |
| `tests/creative-library-distribution.test.ts`       | lease/heartbeat/expiry/first-wins               |
| `tests/creative-library-sidecars.test.tsx`          | cached text and group lifecycle saga            |
| `tests/creative-library-tasks.test.tsx`             | task CRUD, multi-attach, drag, previews, dates  |
| `tests/creative-library-sharing.test.ts`            | exact permission-on-demand/share preference     |
| `tests/creative-library-security.test.ts`           | forbidden payloads and no-leak boundaries       |
| `tests/creative-library-workspace.test.tsx`         | navigation, permissions, Realtime composition   |

## Evidence log

Recorded on 2026-08-14. All commands below ran only against the repository, temporary local
agent state, deterministic mocks or the isolated local Supabase stack. No production
migration, Drive mutation, Cloudflare deployment, package, version change, tag or release was
performed.

### Executed gates

| Command                                                                                        | Result                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npx supabase db reset --local`                                                                | PASS; the feature migrations applied to the isolated PostgreSQL 17 stack                                                            |
| `npm run test:creative-library`                                                                | PASS; 16 files and 57 tests, 4.82 s wall time                                                                                       |
| `npm test`                                                                                     | PASS; 150 files passed and 3 manual files skipped; 821 tests passed and 6 skipped                                                   |
| `npm run test:team`                                                                            | PASS; 29 files and 203 tests                                                                                                        |
| `npm run test:db`                                                                              | PASS; 3 pgTAP files and 343 assertions; the Creative Library plan contains 79 assertions                                            |
| `npm run generate:team-contract -- --check`                                                    | PASS; generated team contract is current                                                                                            |
| `npm run lint`                                                                                 | PASS                                                                                                                                |
| `npm run build:web`                                                                            | PASS; shared TypeScript, web TypeScript and Vite production build                                                                   |
| `npm run build -w @video-compressor/agent`                                                     | PASS; agent TypeScript build                                                                                                        |
| `npm run test:agent:e2e`                                                                       | PASS; local agent handshake, Creative Library guarded route, Optimal/Custom/image-embedded FFmpeg flows and unchanged source hashes |
| `npx vitest run tests/i18n.test.ts tests/release.test.ts tests/creative-library-agent.test.ts` | PASS; 3 files and 23 tests                                                                                                          |
| Feature-scoped `prettier --check`                                                              | PASS after formatting the feature-owned files                                                                                       |
| `git diff --check`                                                                             | PASS                                                                                                                                |

`npm run format:check` remains non-zero because of six pre-existing files outside this
feature's edits: `apps/web/index.html`, three files under `apps/web/src/landing-viewer/`,
`tests/branding.test.ts`, and `tests/landing-viewer-source.test.tsx`. The feature-scoped
format check is green; these unrelated files were intentionally not rewritten.

### Automated V1–V9 evidence

| Validation | Executed automated evidence                                                                                                                       | Boundary not claimed                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| V1         | Shared parser/SQL parity, 79 feature pgTAP assertions, RLS/ACL/search-path and forbidden-payload fixtures passed                                  | No production database was queried                  |
| V2         | Deterministic 100-item bulk start/resume/partial/idempotency and language/thumbnail fixtures passed                                               | No live 100-file Drive upload                       |
| V3         | Finds↔Library planning, structural correction, group reconciliation and partial-state UI fixtures passed                                          | No live My Drive/Shared Drive move matrix           |
| V4         | Scan/current/stale/variant, repeated-run and Process Library confirmation fixtures passed                                                         | No provider-backed Whisper/landing result upload    |
| V5         | Claim/heartbeat/expiry/reclaim/first-wins and agent delegation fixtures passed                                                                    | No three-physical-computer/network-loss run         |
| V6         | Deterministic sidecar names, cached View/Copy/Transcribe and move/trash/restore group fixtures passed                                             | No live Drive trash/restore matrix                  |
| V7         | Create-and-open, 250-reference chunking/deduplication, multi-drag parsing, 1-second seek readiness, progress/date contracts and task pgTAP passed | No moderated drag/search usability sample           |
| V8         | Public/restricted/exact-item/canShare/remember/reset and truthful clipboard fixtures passed through injected Drive adapters                       | No live permission mutation was attempted           |
| V9         | Separate Local Processing/Human Activity allowlists, admin aggregates, no-combined-score/privacy checks and workspace integration tests passed    | No production analytics or Busy Bees ranking exists |

The deterministic scale fixture planned 10,000 Library assets and paged 10,000 tasks with
100,000 attachment references; both assertions remained below their individual 2 s local
budgets. Vitest reported 212 ms for the complete benchmark file during the feature run. This
is an in-memory regression fixture, not provider/network latency evidence.

Fixture aggregate SHA-256 (all `tests/creative-library-*` files plus the feature pgTAP file):
`2dc912bd0537be422aa11b5bd9a547f648f33d6cebd9477ca01c6d3cdb6c280c`.

### Phase 11 reconciliation evidence (2026-08-15 post-clarify delta)

After the 2026-08-15 clarifications, the Phase 11 items were reconciled against the shipped
implementation rather than rebuilt:

- **T087 — Type = six values.** `structural_type` is derived server-side as
  `initcap(coalesce(category,'unknown'))` from the closed classifier `MATERIAL_CATEGORIES`
  (`video|image|archive|transcript|landing|other`), enforced by the SQL
  `team_materials_category_check`. Added a shared parity guard in
  `tests/creative-library-contract.test.ts`; Type labels resolve to
  Video/Image/Archive/Transcript/Landing/Other or Unknown.
- **T088 — offer folders.** FR-003a relaxed to the shipped case/whitespace-insensitive key
  (`lower(regexp_replace(btrim(value),'\s+',' ','g'))`). Distinct offers never collide; name
  variants share one canonical folder with no silent display-value replacement. No suffix
  scheme, migration or Edge change was required.
- **T089 — transcript format.** Verified by inspection: `apps/agent/src/team-bridge/process.ts`
  writes `transcript.txt`/`translation.txt` as UTF-8 `text/plain`, joining segments with `\n`
  (no timestamps). FR-042 already satisfied; no code change.
- **T090 — Type rendering.** Added the `archive` glyph in `LibraryAssetCard.tsx` so all six
  categories render distinctly; offer-disambiguation copy became moot under the relaxation.

Reconciliation test run (Node 26, `--no-experimental-webstorage`):
`vitest run tests/creative-library-{contract,sidecars,workspace,placement}.test.*` → 21 passed
(contract 9, placement 4, sidecars 3, workspace 5). No production database, Drive or release
action occurred.

### Explicitly pending external evidence

- Live My Drive and Shared Drive matrices: 100+ real mixed uploads, duplicate-folder races,
  exact parent changes, sidecar move/trash/restore and exact-item sharing permissions.
- Real network/provider interruption, token expiry, capability revocation and three-computer
  lease-reclaim tests.
- Provider-backed Whisper/translation/landing optimization outputs through scoped grants.
- Moderated accessibility and usability validation with 20 participants across desktop,
  tablet and mobile.

These conditions remain pending until the required accounts, provider roots, networks and
participants are available; no result or pass rate has been inferred.
