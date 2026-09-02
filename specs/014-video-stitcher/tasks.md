---

description: "Task list for the Video Stitcher (feature 014)"
---

# Tasks: Video Stitcher

**Input**: Design documents from `/specs/014-video-stitcher/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. The constitution makes `npm run format:check`, `npm run lint` and
`npm test` gates for every PR, and `quickstart.md` names the suites this feature must ship
with, so test tasks are part of the work rather than optional extras.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested
and demonstrated on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: Which user story the task belongs to (US1…US4)
- Every task names the exact file it touches

## Path Conventions

Monorepo, per plan.md: `packages/shared/src/`, `apps/agent/src/`, `apps/web/src/`, and the
central `tests/` directory (`*.test.ts(x)`, never co-located).

**Machine discipline** (applies to every task that runs anything): check `uptime` first, run
one heavy process at a time under `nice -n 15`, give vitest
`--maxWorkers=1 --minWorkers=1 --no-file-parallelism`, and never run `npm run verify`.

---

## Phase 1: Setup (Contract & Registration)

**Purpose**: Put the tool on the map — its contract, its id, its route — so everything after
this compiles against one definition.

- [X] T001 Create the contract surface in `packages/shared/src/stitcher.ts`: `StitchOperation`, `StitchStatus`, `STITCH_LIFECYCLE`, `StitchUnsupportedReason`, `StitchDestination`, `SourceProfile`, `DetectedStitching`, `StitchScreens`, `StitchPlan`, `StitchJob`, `StitchVerification`, `StitchSettings`, `StitcherState` — per `contracts/shared-types.md` and `data-model.md`, importing `ImageAsset` / `ImageFitMode` / `FinalImageDurationMode` from `types.ts` rather than restating them
- [X] T002 Export the new module from `packages/shared/src/index.ts` and rebuild with `npm run build -w @video-compressor/shared`
- [X] T003 [P] Add `stitcher: 1` to `AGENT_TOOL_CONTRACTS` and `stitcher: { stitcher: 1, imageEmbedding: 2 }` to `WEB_TOOL_REQUIREMENTS` in `packages/shared/src/release.ts`, with a comment recording that this map is byte-compared against the signed `stable.json` by `scripts/verify-release.mjs:83`
- [X] T004 [P] Add `'stitcher'` to `AGENT_CAPABILITIES` in `packages/shared/src/types.ts` (no platform requirement — it needs only FFmpeg)
- [X] T005 [P] Add the `videoStitcher` feature flag (`protected: true` until release) to `apps/web/src/lib/feature-flags.ts`
- [X] T006 [P] Add `StitcherIcon` to `apps/web/src/components/tool-icons.tsx`
- [X] T007 Register the tool in `apps/web/src/lib/tool-registry.ts`: id `stitcher`, path `/stitcher`, `capability: 'stitcher'`, `featureFlag: 'videoStitcher'`, lazily imported `StitcherPage`
- [X] T008 [P] Add the tool's English and Ukrainian keys (name, description, plan line, every error sentence from `contracts/agent-http.md`) to `apps/web/src/i18n.ts`
- [X] T009 [P] Add the `stitcher` analytics tool id and its typed events to `apps/web/src/analytics/events.ts`
- [X] T010 Document the release consequence in `RELEASE_NOTES.md` and `AGENTS.md`: the stitcher ships with an agent release because `deploy:web` fails until a manifest carries the new tool map

**Checkpoint**: `npm run build -w @video-compressor/shared` and `npm run build -w @video-compressor/agent` pass; the tool tile appears (locked) with no page behind it yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The primitives every operation is assembled from — reading a source, building a
screen, joining segments, proving the result. Nothing story-specific lives here.

**⚠️ CRITICAL**: No user story can begin until this phase is complete.

### Tests (write first, watch them fail)

- [X] T011 [P] Write `tests/stitch-presets.test.ts`: argument builders produce the exact flags research.md fixed — `-video_track_timescale` copied from the source, `in_range=full:out_range=tv` plus `-color_range tv` on every screen (D5), the end screen at `-loop 1 -framerate 1` (D2), the start screen at ≥ 2 frames (D3), `-frames:a N` never `-t D` for silence (D4), and a thrown error rather than a spawn when a looped image would be shorter than one frame period (D8)
- [X] T012 [P] Write `tests/stitch-probe.test.ts`: `ffprobe` payloads are narrowed from `unknown`, malformed and partial JSON produce `{ ok: false }` rather than a cast, and a variable frame rate / non-H.264 / non-AAC source resolves to the right `StitchUnsupportedReason`
- [X] T013 [P] Write `tests/stitch-plan.test.ts`: `planStitch` snaps every screen duration to whole AAC frames (D4), infers `stitch` vs `restitch` from the detected edges (FR-027), sets `headReencodeUntilSeconds` only when the body's start is not in `keyframeTimes` (D6), and computes `promisedDurationSeconds` / `promisedFrameCount` consistently
- [X] T014 [P] Write `tests/stitch-verify.test.ts`: a deviation of one AAC frame plus one video frame passes, the two-second track disagreement observed in D7 fails, and a codec / size / pixel-format change always fails

### Implementation

- [X] T015 Implement the pure planner `planStitch` plus `snapToAacFrames`, `clampStitchEndDuration`, `parseSourceProfile` and `parseStitchSettingsPatch` in `packages/shared/src/stitcher.ts` (shared so the web preview and the agent run compute from identical maths)
- [X] T016 [P] Implement the argument builders in `apps/agent/src/ffmpeg/stitch-presets.ts`: `buildScreenVideoArgs`, `buildSilenceSliceArgs`, `buildSegmentMuxArgs`, `buildBodyRemuxArgs`, `buildHeadReencodeArgs`, `buildConcatArgs` — all pure, all reusing `imageAdaptationFilter` from `presets.ts`
- [X] T017 Implement `apps/agent/src/stitcher/probe.ts`: one `ffprobe` call for streams and format plus a keyframe pass (`-select_streams v -skip_frame nokey`), narrowed into `SourceProfile` with `keyframeTimes`
- [X] T018 [P] Implement `apps/agent/src/stitcher/silence.ts`: one raw-ADTS AAC silence bank per `(sampleRate, channels)` under the Application Support root, built once and reused, sliced by exact frame counts (D4)
- [X] T019 Implement `apps/agent/src/stitcher/segments.ts`: build a screen segment (video + silence, muxed, timestamps zeroed) matched to a `SourceProfile`, inside a `mkdtemp` directory cleaned in `finally`
- [X] T020 Implement `apps/agent/src/stitcher/body-cache.ts`: prepared bodies keyed on (absolute path, size, mtime, cut points), stream-copy remux with `-avoid_negative_ts make_zero -muxdelay 0 -muxpreload 0`, the bounded head re-encode when the body's start is not a keyframe (D6), LRU eviction against a size ceiling, staged into place with `rename`
- [X] T021 [P] Implement `apps/agent/src/stitcher/verify.ts`: probe the finished file and compare it against its `StitchPlan` with the tolerances from T014
- [X] T022 Implement `apps/agent/src/stitcher/queue.ts`: `StitchQueue` running one job at a time through `spawnManaged`/`PowerGovernor`, holding the live child for cancellation (SIGTERM → SIGKILL), persisting state like the other queues, and following `STITCH_LIFECYCLE`
- [X] T023 Implement `apps/agent/src/stitcher/routes.ts`: `registerStitcherRoutes(app, ctx)` with `GET /api/stitcher/state`, `POST /api/stitcher/jobs`, `POST /api/stitcher/jobs/:id/cancel`, `PATCH /api/stitcher/settings` and the `stitcher` SSE channel, returning the state snapshot on success and machine codes on failure per `contracts/agent-http.md`
- [X] T024 Wire the module in: a `ToolModule` entry (`id`, `lifecycle`, `register`, `busy`, `cancel`, `cancelAll`, `shutdown`) in `apps/agent/src/server/tools.ts`, `'stitcher'` advertised in `apps/agent/src/server/capabilities.ts`, and construction plus its SSE channel in `apps/agent/src/index.ts`
- [X] T025 [P] Write `tests/stitch-routes.test.ts` against a real assembled server: every status code and machine code in `contracts/agent-http.md`, including `UPDATE_PENDING` while a pending update drains
- [X] T026 Implement `apps/web/src/stitcher/api.ts` (typed `request`/`requestBody` wrappers) and `apps/web/src/stitcher/StitcherContext.tsx` (`createContext<T | null>(null)`, `useStitcher()` that throws outside its provider, `StitcherContextOverride` for tests, single SSE subscribe-and-reconnect path)
- [X] T027 Implement the page shell `apps/web/src/stitcher/StitcherPage.tsx`: pick a video, pick a photo from the existing library, press start — three actions, no configuration required (FR-026, SC-007)

**Checkpoint**: the agent starts, advertises `stitcher`, answers `/api/stitcher/state`, and the page opens and connects. No operation runs yet.

---

## Phase 3: User Story 1 - Re-stitch a creative with a new photo (Priority: P1) 🎯 MVP

**Goal**: Replace the screens of an already-stitched video with new ones in seconds, leaving
the body untouched.

**Independent Test**: Re-stitch a Soty-made creative with a different photo; the new screens
are present, the middle section is unchanged, and the run takes under 5 seconds (quickstart
check 1).

### Tests for User Story 1

- [X] T028 [P] [US1] Write `tests/stitch-integration.test.ts` (real FFmpeg, `it.skipIf(!available)` — never a silent `return`): build the legacy-shaped 1080×1080 fixture from `quickstart.md`, re-stitch it, and assert the promised duration / frame count / track agreement, the source's codec and size preserved, and a colour probe inside the end screen returning a frame (the D2 seekability regression guard)
- [X] T029 [P] [US1] Write `tests/stitcher-page.test.tsx` (jsdom): picking a video shows the one-line plan before anything runs, start is reachable in three actions, and a finished job shows its elapsed time

### Implementation for User Story 1

- [X] T030 [US1] Implement `apps/agent/src/stitcher/plan.ts`: assemble `SourceProfile` + `detectStaticEdgeTrims` (reused from `apps/agent/src/images/static-edges.ts`, refined to frame precision) + the user's screens into a `StitchPlan` through the shared `planStitch`
- [X] T031 [US1] Add `POST /api/stitcher/inspect` to `apps/agent/src/stitcher/routes.ts`, returning `{ profile, detected, plan }` and the `STITCH_SOURCE_UNSUPPORTED` / `STITCH_PATH_INVALID` codes
- [X] T032 [US1] Implement the re-stitch run in `apps/agent/src/stitcher/queue.ts`: prepared body (T020) → both screens (T019) → FFconcat list → `-c copy -movflags +faststart` → verify (T021), with `progressStage` published at each step
- [X] T033 [US1] Reuse the compressor's destination and naming rules — `nextOutputPath` from `apps/agent/src/files/paths.ts`, the optional suffix, and `overwrite` committed only after a verified success — in `apps/agent/src/stitcher/queue.ts` (FR-021, FR-022)
- [X] T034 [US1] Record and report `elapsedMs` per finished job in `apps/agent/src/stitcher/queue.ts` (FR-019)
- [X] T035 [P] [US1] Implement `apps/web/src/stitcher/StitchPlanLine.tsx`: one line naming what was found, what will be produced and the resulting length, with the boundaries adjustable but never required (FR-028)
- [X] T036 [P] [US1] Implement `apps/web/src/stitcher/StitchQueueList.tsx`: per-item stage, result, elapsed time and failure sentence
- [X] T037 [US1] Map every `StitchUnsupportedReason` and job failure code to its one-sentence message plus the link to the compressor in `apps/web/src/stitcher/StitcherPage.tsx` and `apps/web/src/i18n.ts` (FR-023, FR-024)
- [X] T038 [US1] Verify the measured budget from research.md D9 on the real fixture: first touch ≈ 2.3 s, a second photo on the same body ≈ 0.6 s, and a 45-second end screen within 10% of a 3-second one (SC-001, SC-002)

**Checkpoint**: US1 is fully usable on its own — the MVP.

---

## Phase 4: User Story 2 - One video, many photos (Priority: P2)

**Goal**: Queue a set of photos against one video and get one finished creative per photo,
unattended.

**Independent Test**: Select one video and five photos, start, and confirm five distinctly
named outputs with the identical body (quickstart check 6).

### Tests for User Story 2

- [X] T039 [P] [US2] Write `tests/stitch-queue.test.ts`: N jobs run one at a time, a failing item does not stop the rest (FR-020), cancellation leaves no partial file and no orphaned child, and the queue survives a restart with its items intact

### Implementation for User Story 2

- [X] T040 [US2] Accept a multi-photo selection in `apps/web/src/stitcher/StitcherPage.tsx` and enqueue one job per photo through `apps/web/src/stitcher/api.ts`
- [X] T041 [US2] Give each output a distinct name in `apps/agent/src/stitcher/queue.ts` (suffix, else automatic numbering) so a batch never collides (FR-022)
- [X] T042 [US2] Confirm the prepared body is computed once for the batch in `apps/agent/src/stitcher/body-cache.ts` — assert a cache hit for items 2…N rather than a second preparation (FR-018, SC-005)
- [X] T043 [US2] Show per-item progress and per-item failure without aborting the batch in `apps/web/src/stitcher/StitchQueueList.tsx`

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 - Stitch a clean video for the first time (Priority: P3)

**Goal**: Add screens to a video that has none.

**Independent Test**: Stitch a clean video and confirm the output equals the source plus both
screens, with the source content unchanged (quickstart check 4).

### Tests for User Story 3

- [X] T044 [P] [US3] Extend `tests/stitch-plan.test.ts`: a source with no detected edges plans as `stitch`, with no cuts and no head re-encode
- [X] T045 [P] [US3] Extend `tests/stitch-integration.test.ts`: stitching the clean fixture yields source duration plus both screens, and each fit mode leaves the wide photo undistorted (FR-015)

### Implementation for User Story 3

- [X] T046 [US3] Handle the no-cut path in `apps/agent/src/stitcher/queue.ts`: the prepared body is a plain timestamp-zeroing remux, never a re-encode
- [X] T047 [US3] Support a start screen, an end screen, or both — including neither-is-required validation — in `packages/shared/src/stitcher.ts` and `apps/web/src/stitcher/StitcherPage.tsx` (FR-004)
- [X] T048 [US3] Report the actually used end-screen duration for the random modes on the job in `apps/agent/src/stitcher/queue.ts` (FR-013)

**Checkpoint**: US1, US2 and US3 all work independently.

---

## Phase 6: User Story 4 - Remove the stitching (Priority: P4)

**Goal**: Strip the screens back off and recover the clean body.

**Independent Test**: Un-stitch a Soty-stitched video and confirm the result matches the body
that was stitched to within one frame (quickstart check 5).

### Tests for User Story 4

- [X] T049 [P] [US4] Extend `tests/stitch-plan.test.ts`: `unstitch` on a source with no detected edges resolves to `nothing-to-remove`
- [X] T050 [P] [US4] Extend `tests/stitch-integration.test.ts`: un-stitching returns the original body duration to within one frame (SC-006) and writes no file when there is nothing to remove (FR-008)

### Implementation for User Story 4

- [X] T051 [US4] Handle the screens-less output path in `apps/agent/src/stitcher/queue.ts`: the prepared body *is* the output, verified and named like any other run
- [X] T052 [US4] Expose "remove the stitching" as the one explicitly asked-for operation in `apps/web/src/stitcher/StitcherPage.tsx`, and surface `STITCH_NOTHING_TO_REMOVE` as a plain statement rather than an error (FR-006, FR-008)

**Checkpoint**: every operation in the spec is implemented and independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T053 [P] Confirm the edge cases in spec.md behave: a source with no audio produces silent screens and no invented audio track, a source shorter than its screens states the resulting duration up front, and static content in the middle is never mistaken for a screen — add the missing cases to `tests/stitch-plan.test.ts`
- [X] T054 [P] Prove nothing is ever damaged (SC-008) in `tests/stitch-queue.test.ts`: cancel mid-run, a read-only destination under `overwrite`, and a destination that disappears — original intact, no partial file, temp directory gone
- [X] T055 [P] Document the tool in `README.md` and `TESTER_GUIDE.md`, including that it declines what it cannot stitch fast and why
- [X] T056 [P] Add the tool to `docs/` where the other tools' operational notes live, with the research.md numbers as the performance baseline
- [X] T057 Run `npm run format`, then `npm run lint`, then the focused stitcher tests, then the full `npm test` — sequentially, one heavy process at a time
- [X] T058 Build the agent (`npm run build -w @video-compressor/agent`) — CI never does, so its type errors surface only here
- [X] T059 Walk `quickstart.md` end to end on real files and record the measured times against SC-001, SC-002 and SC-005
- [ ] T060 (deliberately open) Flip `videoStitcher` to `protected: false` in `apps/web/src/lib/feature-flags.ts` only once T059 passes, and only in the release that also ships the agent contract (T003, T010)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — starts immediately
- **Foundational (Phase 2)**: needs Phase 1; **blocks every user story**
- **US1 (Phase 3)**: needs Phase 2 — the MVP
- **US2 (Phase 4)**: needs Phase 2; reuses US1's run path, so it lands most easily after US1
- **US3 (Phase 5)**: needs Phase 2; independent of US1 and US2
- **US4 (Phase 6)**: needs Phase 2; independent of US1–US3
- **Polish (Phase 7)**: needs every story that is going to ship

### Within Each Story

Tests first and failing → shared/pure logic → agent pipeline → routes → web. The planner
(T015) precedes anything that consumes a plan; the prepared body (T020) precedes any run;
verification (T021) precedes any job being reported successful.

### Parallel Opportunities

- Phase 1: T003–T006, T008, T009 are separate files and run together
- Phase 2 tests: T011–T014 together, before their implementations
- Phase 2 implementation: T016, T018 and T021 touch separate files and run together; T017, T019, T020, T022, T023 form the dependency chain
- US1: T028 and T029 together; T035 and T036 together
- US3 and US4 can be built in parallel with US2 once Phase 2 is done
- Phase 7: T053–T056 together; T057–T059 are strictly sequential on this machine

## Parallel Example: Phase 2 tests

```bash
# One vitest run, single worker, all four foundational suites:
npx vitest run tests/stitch-presets.test.ts tests/stitch-probe.test.ts \
  tests/stitch-plan.test.ts tests/stitch-verify.test.ts \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 — Setup
2. Phase 2 — Foundational (blocks everything)
3. Phase 3 — US1
4. **Stop and validate**: quickstart checks 1–3, then the D9 budget (T038)
5. Demo behind the feature flag

### Incremental delivery

1. Setup + Foundational → the engine exists
2. + US1 → re-stitch works → **MVP**
3. + US2 → batches of photos
4. + US3 → first-time stitching
5. + US4 → removal, closing the round trip
6. Polish, then flip the flag with the agent release
