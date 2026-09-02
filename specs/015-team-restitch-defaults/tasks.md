---
description: 'Task list for feature 015 — re-stitch defaults and prepared materials in the team space'
---

# Tasks: Re-stitch defaults and prepared materials in the team space

**Input**: Design documents from `/specs/015-team-restitch-defaults/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: included. This repository gates on them — the constitution requires RLS proofs for
every new table and the quickstart names the suites — so test tasks are written per story
rather than left to the end.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on an unfinished task
- **[Story]**: which user story the task serves
- Every task names the exact file it touches

## Path Conventions

Monorepo, as `plan.md` records: `packages/shared/src/` (contract), `apps/agent/src/` (local
agent), `apps/web/src/` (web app), `supabase/` (schema and edge functions), `tests/` (central
Vitest suites), `supabase/tests/database/` (pgTAP).

---

## Phase 1: Setup

- [X] T001 Add the shared contract module `packages/shared/src/team/restitch.ts` with
      `TeamRestitchDefaults`, `MaterialRestitchPrep` and `TeamRestitchPrepareProgress`, each
      built only from existing unions (`StitchOperation`, `ImageFitMode`,
      `FinalImageDurationMode`) — no new bound is declared here
- [X] T002 Export the new module from `packages/shared/src/team/index.ts` and confirm
      `npm run build -w @video-compressor/shared` succeeds
- [X] T003 [P] Add the parse guards for all three types in
      `packages/shared/src/team/restitch.ts`, each returning
      `{ ok: true; value } | { ok: false; error }`, reusing `parseSourceProfile` for the
      profile inside `MaterialRestitchPrep`
- [X] T004 [P] Add `restitchDefaultsSaveable(defaults)` to
      `packages/shared/src/team/restitch.ts` — the single predicate behind FR-005, used by
      both the RPC contract test and the settings section
- [X] T005 [P] Add the translation keys for the whole feature to `apps/web/src/i18n.ts`
      (section title, summary line, not-configured state, the toast and its action, the
      preparation states, every refusal code)

---

## Phase 2: Foundational (blocks every story)

**Purpose**: the three tables, their access, and the typed wrappers every story calls.

- [X] T006 Write `supabase/migrations/20260902150000_team_restitch_defaults.sql` creating
      `public.team_restitch_defaults`, `public.team_material_restitch_prep` and
      `public.team_workspace_folders` exactly as `data-model.md` describes, each with
      `enable row level security`, `revoke all`, and column-scoped grants
- [X] T007 In the same migration, add `public.get_restitch_defaults(uuid)` and
      `public.set_restitch_defaults(uuid, jsonb)` as `security definer` with
      `set search_path = ''`, fully-qualified names, raising `RESTITCH_FORBIDDEN`,
      `RESTITCH_NO_SCREENS` and `RESTITCH_INVALID` per `contracts/supabase-rpc.md`
- [X] T008 In `supabase/migrations/20260902150000_team_restitch_defaults.sql`, add
      `public.get_material_restitch_prep(uuid, uuid[])` and
      `public.set_material_restitch_prep(uuid, text, jsonb)` with the same posture; reads
      return only records whose `drive_version` matches the material's current one
- [X] T009 In `supabase/migrations/20260902150000_team_restitch_defaults.sql`, grant execute
      on all four functions to `authenticated` and nothing else, and add the `team_restitch_*`
      policies mirroring `team_share_preferences_select_self`
- [X] T010 [P] Write `supabase/tests/database/team-restitch.test.sql` proving: a member of
      another space reads neither table; a member without `manage_metadata` cannot write the
      defaults; a member without `process` cannot write a preparation record; a preparation
      row with a stale `drive_version` is not returned
- [X] T011 Add the four typed RPC wrappers to `apps/web/src/api/team.ts`
      (`getRestitchDefaults`, `setRestitchDefaults`, `getMaterialRestitchPrep`,
      `setMaterialRestitchPrep`), each handling `{ data, error }` explicitly and narrowing
      through the Phase 1 guards
- [X] T012 [P] Gate the feature on the live contract check in `apps/web/src/api/client.ts` —
      `toolContractCompatible('stitcher', health.toolContracts)` before the choice is offered.
      `WEB_TOOL_REQUIREMENTS` in `packages/shared/src/release.ts` is deliberately **not**
      touched here: it is compared byte-for-byte with the signed manifest, so an early entry
      would fail `scripts/verify-release.mjs` for the whole development window (see T063)

**Checkpoint**: `supabase test db` passes and the web can read and write a space's defaults.

---

## Phase 3: User Story 1 — Set the defaults once (P1) 🎯 MVP

**Goal**: a space has one saved answer for re-stitching, set from its settings.

**Independent test**: open the settings of a space with no defaults, set them, reload, and see
them still set. No material is touched.

### Tests for User Story 1

- [X] T013 [P] [US1] Write `tests/team-restitch-defaults.test.ts` covering the wrappers and
      the refusal predicate: a saveable set round-trips; an operation needing a screen with no
      image is refused with `RESTITCH_NO_SCREENS`; an out-of-range hold length is clamped by
      the shared helper rather than rejected
- [X] T014 [P] [US1] Write `tests/team-restitch-section.test.tsx` rendering the section
      against a stubbed client: not-configured state, the summary line after saving, and
      read-only for a member without `manage_metadata`

### Implementation for User Story 1

- [X] T015 [US1] Create `apps/web/src/team/workspace/RestitchDefaultsSection.tsx` mounting the
      stitcher's own controls — the operation picto row, `ImageEmbeddingSection`'s two
      galleries, the fit-mode row and the hold-duration ranges — with no new control invented
- [X] T016 [US1] Add the state line and the one-line summary to
      `apps/web/src/team/workspace/RestitchDefaultsSection.tsx`, driven by `configured`
      (FR-004)
- [X] T017 [US1] Wire save and refusal through `apps/web/src/api/team.ts`, mapping each machine
      code to one translated line from T005 (FR-005)
- [X] T018 [US1] Gate editing on `manage_metadata` in
      `apps/web/src/team/workspace/RestitchDefaultsSection.tsx`, showing the reason rather than
      hiding the controls (FR-003)
- [X] T019 [US1] Mount the section in `apps/web/src/team/workspace/SpaceSettings.tsx` beside
      the existing sections, in the same grid

**Checkpoint**: User Story 1 is complete and testable on its own.

---

## Phase 4: User Story 2 — Download a material already re-stitched (P1)

**Goal**: Download → re-stitched on a video produces the finished file with progress and no
further click.

**Independent test**: with defaults set and nothing prepared, download a video re-stitched and
confirm the delivered file carries new screens and the source's own body.

**Depends on**: Phase 2. Uses the defaults from Phase 3 but can be developed against a stubbed
defaults client.

### Tests for User Story 2

- [X] T020 [P] [US2] Write `tests/team-restitch-delivery.test.ts` against an assembled agent:
      a delivery with a prepared record never probes or detects; a delivery without one does
      both and returns `discovered`; an unsupported source answers `415` with its reason
- [X] T021 [P] [US2] Extend `tests/team-restitch-delivery.test.ts` with cancellation: a stop
      mid-run leaves no file at the destination and no temp directory behind
- [X] T022 [P] [US2] Prove the output by comparison, not by inspection, in
      `tests/stitch-integration.test.ts` where a real media engine already runs: drive a
      delivery through `createRestitchDelegate` and hash the delivered file's body frames
      against the source's with the `frameHashes` helper that file already has (FR-009,
      SC-007). It cannot live in `tests/team-restitch-delivery.test.ts`, whose pipeline is a
      stub — there is no picture there to compare.
- [X] T023 [P] [US2] Prove nothing of the member's is touched, in
      `tests/team-restitch-delivery.test.ts` and `tests/team-restitch-prepare.test.ts`: take a
      sha256 of every source before a delivery and before a preparation, and assert it is
      unchanged afterwards. Half of it is done — the delivery — and the preparation's half
      waits for `tests/team-restitch-prepare.test.ts`; the guarantee `real-media-e2e` makes for the
      compressor (FR-024, SC-008)

### Implementation for User Story 2

- [X] T024 [US2] Add a `restitch` delegate to
      `apps/agent/src/team-bridge/process.ts` (`createTeamProcessDelegates`), driving the
      existing stitcher pipeline and honouring the delegate's `signal`, `onProgress` and pause
      offer like its siblings
- [X] T025 [US2] Widen `TeamAgentDownloadRequest` in `apps/agent/src/team-bridge/download.ts`
      from `compress?: { embed, suffix }` to the discriminated `process?` of
      `contracts/agent-http.md`, keeping `compress` accepted for one release
- [X] T026 [US2] In `apps/agent/src/team-bridge/download.ts`, skip the probe and the detection
      when `process.prepared` is present, and return `discovered` when it had to inspect
      (FR-023)
- [X] T027 [US2] In `apps/agent/src/team-bridge/download.ts`, accept an already-granted
      `destination` and only fall back to the native picker when it is absent (research D7)
- [X] T028 [US2] Publish the delivery's four phases — transferring, inspecting, stitching,
      saving — on the bridge's existing event channel from
      `apps/agent/src/team-bridge/download.ts`
- [X] T029 [US2] Wire the delegate into `apps/agent/src/index.ts` where
      `createTeamProcessDelegates` is called, passing the stitcher queue alongside the
      compressor
- [X] T030 [US2] Extend `downloadTeamFileWithAgent` in `apps/web/src/api/client.ts` with the
      new `process` shape and the `stitcher` contract check through `toolContractCompatible`
- [X] T031 [US2] Create `apps/web/src/team/restitch/useRestitchDelivery.ts` — one hook holding
      a delivery: reads the defaults, reads any prepared record, calls the agent, follows the
      phases, stores `discovered` back through `setMaterialRestitchPrep`
- [X] T032 [US2] Remember the space's download folder in
      `apps/web/src/team/restitch/useRestitchDelivery.ts`, asking through the native picker
      only the first time (research D7)
- [X] T033 [US2] Turn the single Download entry into a choice of original / re-stitched for
      video rows in `apps/web/src/team/catalog/MaterialRowMenu.tsx`, leaving every other kind
      untouched (FR-007)
- [X] T034 [US2] Wire the choice through `apps/web/src/team/explorer/RowActions.tsx` and show
      the running phase on the row using the existing per-row progress
- [X] T035 [US2] Keep a finished result retrievable from the row for the rest of the session
      in `apps/web/src/team/restitch/useRestitchDelivery.ts` (FR-015), and abort the run from
      the hook's cleanup so leaving the folder or the page ends it as cleanly as pressing
      cancel (FR-013)
- [X] T036 [US2] Decide and apply the delivered file's name in
      `apps/agent/src/team-bridge/download.ts` — the source's name plus the space's suffix,
      defaulting to `_restitched`, never the bare original — and assert it in
      `tests/team-restitch-delivery.test.ts` (FR-014)
- [X] T037 [US2] Map every refusal to one sentence in
      `apps/web/src/team/restitch/useRestitchDelivery.ts` — the unsupported reasons, a missing
      agent, a missing image — and keep the original download offered (FR-010)

**Checkpoint**: a member with defaults set can get a re-stitched file, prepared or not.

---

## Phase 5: User Story 3 — Told the defaults are missing, and fixing it in place (P1)

**Goal**: the first use of the feature is never a dead end.

**Independent test**: in a space with no defaults, pick Download → re-stitched and reach a
delivered file without navigating away.

**Depends on**: Phase 3 (the section to mount) and Phase 4 (the delivery to resume). This is
the one story that genuinely needs both.

### Tests for User Story 3

- [X] T038 [P] [US3] Extend `tests/team-restitch-section.test.tsx` with the empty-state path:
      the toast appears with its action, the dialog mounts the same section, and saving resumes
      the pending delivery exactly once

### Implementation for User Story 3

- [X] T039 [US3] Create `apps/web/src/team/restitch/RestitchDeliveryNotices.tsx` raising every
      notice a delivery makes, including the **Configure now** one, through the existing
      `useToasts`
- [X] T040 [US3] Open `RestitchDefaultsSection` inside the space's existing
      `apps/web/src/team/workspace/SettingsDialog.tsx` over the current view, rather than
      navigating (FR-011)
- [X] T041 [US3] Hold the pending delivery in
      `apps/web/src/team/restitch/useRestitchDelivery.ts` and resume it once the defaults are
      saved, without a second click
- [X] T042 [US3] For a member without `manage_metadata`, name who can configure the space
      instead of offering the action, in
      `apps/web/src/team/restitch/RestitchDeliveryNotices.tsx` (FR-012)

**Checkpoint**: the three P1 stories together are a shippable increment.

---

## Phase 6: User Story 4 — Prepare the material once (P2)

**Goal**: the Soty folder exists, and the inspection is paid once per material.

**Independent test**: prepare a space, then time a re-stitched download of a long video
against the same download in an unprepared space.

**Depends on**: Phase 2. Independent of Phases 3–5 except that its button lives in the section
built by US1.

### Tests for User Story 4

- [X] T043 [P] [US4] Write `tests/team-restitch-prepare.test.ts`: the prepare run reports one
      progress event per material, stops on cancel keeping what finished, and marks an
      unsupported material without retrying it
- [X] T044 [P] [US4] Extend `tests/team-restitch-prepare.test.ts` with both halves of the
      invalidation rule: a material whose `driveVersion` changed reads as unprepared, and
      changing the space's photos, fit mode and hold length leaves every preparation intact
      (FR-006 — the promise that makes preparation worth building)

### Implementation for User Story 4

- [X] T045 [P] [US4] Prove the folder is found by its marker and never by its name, in
      `tests/team-restitch-prepare.test.ts`: a renamed folder resolves to the same id, a moved
      one likewise, and neither causes a second folder to be created (FR-017)
- [X] T046 [P] [US4] Add the `ensure_workspace_folder` action to
      `supabase/functions/drive-ops/index.ts` following `contracts/supabase-rpc.md`: cached id
      → `appProperties` search → create, with the same authorization as the neighbouring
      actions
- [X] T047 [US4] Persist the folder in `public.team_workspace_folders` from
      `supabase/functions/drive-ops/index.ts`, writing `marker` and `verified_at`
- [X] T048 [P] [US4] Create `apps/agent/src/team-bridge/restitch-prepare.ts` — inspect a list
      of materials one at a time through the existing spawn seam and power governor, reporting
      each on the event channel
- [X] T049 [US4] Build the silence bank once, before the first material, in
      `apps/agent/src/team-bridge/restitch-prepare.ts` (FR-019)
- [X] T050 [US4] Register `POST /api/team/restitch/prepare` and its cancel route in
      `apps/agent/src/team-bridge/routes.ts`, returning `202` and the machine codes of
      `contracts/agent-http.md`
- [X] T051 [US4] Construct the bridge in `apps/agent/src/index.ts` beside the other team
      bridges, sharing the transfer client and the events channel
- [X] T052 [US4] Add `prepareTeamRestitchMaterials` to `apps/web/src/api/client.ts` with the
      contract check, and store each reported `prep` through `setMaterialRestitchPrep`
- [X] T053 [US4] Add **Prepare material** with its per-material progress, its count and its
      stop to `apps/web/src/team/workspace/RestitchDefaultsSection.tsx` (FR-020), ending in the
      tally SC-006 asks for: how many are ready and how many could not be
- [X] T054 [US4] Show whether each material is prepared in
      `apps/web/src/team/explorer/RowActions.tsx`, from the batched read of T011 (FR-021)
- [X] T055 [US4] Handle the no-drive case in
      `apps/web/src/team/workspace/RestitchDefaultsSection.tsx` by offering the existing
      connect flow rather than failing

**Checkpoint**: the ten-second promise is measurable.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T056 [P] Add the three telemetry events (defaults saved, preparation finished, delivery
      finished with its elapsed time and whether it was prepared) to
      `apps/web/src/analytics/events.ts` and emit them from their call sites
- [X] T057 [P] Run `node scripts/verify-a11y.mjs` and fix anything the new section or the
      toast introduces
- [X] T058 [P] Write `docs/TEAM_RESTITCH.md` recording the measured budget, the invalidation
      rule, and the two traps: the folder is found by its marker and never by its name, and
      the preparation deliberately excludes anything a member can change
- [X] T059 [P] Add the feature's row to `TESTER_GUIDE.md` and a line to `RELEASE_NOTES.md`
- [ ] T060 Walk `specs/015-team-restitch-defaults/quickstart.md` end to end against the beta
      environment and record the observed timings in `docs/TEAM_RESTITCH.md`
      **Partly done (2026-09-02).** Verified against the running beta: the section renders and
      saves (`team_restitch_defaults` row: `restitch`, 6+6 photos, `cover`, `random-30-40`,
      `configured`); `POST /drive-ops/ensure-workspace-folder` with a real member JWT answers
      `403 PERMISSION_DENIED` when no drive is connected; the agent publishes `stitcher: 1` and
      `teamWorkspace: 2`, and its three prepare routes answer `202 / 400 INVALID_INPUT /
      404 NOT_FOUND`; a two-material run inspected them **one at a time**, reported each
      failure with its true reason, reached `finished`, and stayed readable afterwards.
      **Still needs the owner**: the beta has no Google Drive connected (only they can grant
      it), so the folder creation, a real preparation and a timed re-stitched download are
      unmeasured.
- [X] T061 Assert the budget rather than only record it, in
      `tests/team-restitch-delivery.test.ts`: with a prepared record, source in hand to
      finished file is under 5 s for both a short and a long fixture, and the second delivery
      of the same material is no slower than the first (SC-001, SC-002, SC-003)
- [X] T062 Run the full affected suite once —
      `npx vitest run tests/team-restitch-*.test.ts tests/stitch-*.test.ts --maxWorkers=1
--minWorkers=1 --no-file-parallelism` — plus `supabase test db`, and confirm no
      pre-existing failure was made worse
- [ ] T063 (deliberately open) Add the team surface's `stitcher` requirement to
      `WEB_TOOL_REQUIREMENTS` in `packages/shared/src/release.ts` **only** in the release that
      also ships the agent contract, and confirm `node scripts/verify-release.mjs` passes with
      the signed manifest that carries the same map

---

## Dependencies & Execution Order

### Phase dependencies

```
Phase 1 (Setup)
   └─▶ Phase 2 (Foundational — tables, RPCs, wrappers)
          ├─▶ Phase 3 (US1 — defaults)  ──┐
          ├─▶ Phase 4 (US2 — delivery)  ──┼─▶ Phase 5 (US3 — empty state)
          └─▶ Phase 6 (US4 — preparation)
                                          └─▶ Phase 7 (Polish)
```

### User story dependencies

- **US1** and **US2** are independent of each other; US2 can be built against a stubbed
  defaults client.
- **US3 depends on both** — it mounts US1's section and resumes US2's delivery. This is stated
  rather than hidden: it is the one story that is not independently deliverable.
- **US4** is independent of US1–US3 in its agent and Supabase halves; only its button lives in
  US1's section, so that one task (T053) waits.

### Within a story

Tests first where they can fail meaningfully, then the shared/agent half, then the web half.
`data-model.md` entities are all created in Phase 2 because every story reads at least one.

### Parallel opportunities

- **Phase 1**: T003, T004, T005 together.
- **Phase 2**: T010 (pgTAP) and T012 (the live contract gate) run beside the migration work.
- **Phase 4**: T020 and T021 together; T024 (agent delegate) and T030–T033 (web) are different
  trees and can proceed in parallel once T025's shape is agreed.
- **Phase 6**: T046 (edge function), T048 (agent bridge) and T043/T044 (tests) are three
  separate trees.
- **Phase 7**: T056–T059 all together.

## Parallel Example: User Story 2

```
# The two test files first, together:
T020  tests/team-restitch-delivery.test.ts — prepared vs unprepared
T021  tests/team-restitch-delivery.test.ts — cancellation

# Then two trees at once:
Agent:  T024 → T025 → T026 → T027 → T028 → T029
Web:    T030 → T031 → T032 → T033 → T034 → T035 → T037
```

## Implementation Strategy

### MVP

**Phases 1–3 (T001–T019).** A space can hold its re-stitching defaults and show them. Nothing
downloads yet, and that is a coherent stopping point: the settings are the thing everything
else reads.

### Incremental delivery

1. **Phases 1–3** — the defaults exist and are shared.
2. **+ Phase 4** — Download → re-stitched works, at today's speed. Already useful: it removes
   the dialog, the tool choice and the hunt for the result.
3. **+ Phase 5** — the first use is no longer a dead end. This is the natural release.
4. **+ Phase 6** — the ten-second promise. Worth its own release note, because it is the part
   with a number attached.
5. **+ Phase 7** — measured, documented, and gated behind the agent release.

### Parallel team strategy

After Phase 2, one person can take the agent side (T024–T029, T048–T051) while another takes
the web side (T015–T019, T030–T037). The contract files in `contracts/` are the agreement
between them; neither should have to read the other's tree.

## Notes

- **Three P1 stories, not one.** The spec makes the empty-state path P1 on purpose: without it
  a member who has never configured the space cannot use the feature at all.
- **T063 stays open on purpose, and nothing before it touches `WEB_TOOL_REQUIREMENTS`.** That
  map is compared byte-for-byte against the signed manifest, so an entry added early would fail
  `scripts/verify-release.mjs` — the gate the constitution requires to pass before any deploy —
  for the whole development window. The live `toolContractCompatible` check (T012) needs no map
  change, so the feature can be built and shipped to beta with a green gate.
- **Nothing here changes what a re-stitch is.** Feature 014's pipeline is used as it stands; if
  a task tempts anyone to alter it, that is a sign the task is wrong.
- **The measurements in `research.md` are the acceptance bar for T061 and T062.** T061 asserts
  the budget in a test; T060 records what a real space actually did. If the two disagree
  materially, the plan is what needs revisiting — not the numbers.
