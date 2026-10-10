# Tasks — feature 012 (media companions)

Delivery rule (same machine constraint as 011): `uptime` before any build; never two builds or
suites at once; vitest single-worker; do the DB/migration and pure-logic tasks first (light on
CPU), the agent/build tasks when the machine has headroom.

Order is dependency-first. Each task is small and independently committable.

## Phase 1 — Companion data model (schema + reads)

- [x] T001 Migration `team_material_companions`: add `companion_of uuid` and
      `companion_kind text` to `team_materials` (nullable; FK to the owning material, check kind in
      `('transcript')`), plus `audio_fingerprint text` for dedup. Index on
      `(team_id, companion_of)` and on `(team_id, audio_fingerprint)`. ROLLBACK entry.
- [x] T002 `get_material_transcript_companion(p_team, p_material, p_actor)` returns the
      linked transcript companion (id, name, ingest_state, text presence) or null; RLS-checked.
- [x] T003 Migration `20261128100000_media_companion_projection.sql`: folder page rows carry `hasTranscriptCompanion` (video rows; true = linked live transcript with text), search results carry `companionOf` / `companionKind` / `hasTranscriptCompanion`; shared types + decoder (optional, older servers send nothing); search results now offer "Copy text" from it. Tests: `team-companions-sql`, `catalog-search`. Extend the catalog projection (`catalog-search` + the folder-page read) with
      `companionOf` / `companionKind` / `hasTranscriptCompanion` so the UI can show state without a
      second call. Update `packages/shared` types + `tests/`.

## Phase 2 — Transcribe → companion (agent + server)

- [x] T004 `apps/agent/src/team-bridge/audio-fingerprint.ts` (ffmpeg → 16 kHz mono s16le → sha256, null on no audio/failure/cancel); the transcription delegate returns it, the bridge passes it to the finalize body (`audioFingerprint`), drive-ops forwards it to `service_link_transcript_companion`, which now stamps it on the video too. Additive: an older agent sends nothing, an older server ignores the field — no tool-contract bump. Test: `team-audio-fingerprint` (real ffmpeg: a re-wrapped copy matches). Agent: on a transcription job, compute a decoded-audio fingerprint (ffmpeg → raw PCM →
      sha256) alongside the text; return both. `apps/agent/src/team-bridge/process.ts`.
- [x] T005 SQL half done (`service_link_transcript_companion` + `service_find_transcript_by_fingerprint`); the .txt is the finalize upload (T006), the fingerprint arrives from the agent (T004), and compute-time dedup runs in the web queue via `find_reusable_transcript` (same Drive checksum or same fingerprint → the existing text is copied, named after this video, linked; no whisper run). `service_commit_transcript_companion(p_team, p_video, p_actor, p_text,
  p_fingerprint, ...)`: create-or-reuse text by fingerprint, mint a companion material named
  `<video-stem>.txt` beside the video, link it, trash any previous companion. Migration + test.
- [x] T006 finalize links a transcription result as the video's companion; end-to-end whisper check deferred (large-v3 on CPU is a long run). Wire the process-output finalize path (`drive-ops/process/output/finalize`) so a
      transcription tool result lands as a companion via T005 rather than a bare `.txt` upload.
- [x] T007 The card's Re-transcribe enqueues with `fresh: true`, which skips the reuse lookup, so whisper always runs and the finalize mints a new companion and retires the old one. Re-transcribe action: a `process` variant that forces a new companion even when a
      fingerprint match exists (owner asked for a fresh id on demand).

## Phase 3 — The tail (rename / move / copy / delete)

- [x] T008 rename tail (client orchestration in useMaterialActions). On video rename (`drive-ops/rename`): rename the linked companion to `<new-stem>.txt`
      in the same commit. Test.
- [x] T009 move tail (client orchestration). On video move (`drive-ops/move`): move the linked companion to the same destination.
      Test.
- [x] T010 Copy was already carried by `copyMaterialWithTail`; compress/embed now carry too via `carryTranscriptAfterProcess` (tail.ts) from all three run surfaces (explorer queue, process dialog, catalog search): the source transcript is copied beside the result, renamed `<result-stem>.txt`, linked. An overwrite (`versionOf`) keeps its companion. Fixes production 2026-10-10 (`claude-test-speech-video_1.mp4` arrived without text). Test: `team-transcript-carry`. On video copy / compress finalize: copy the companion, named after the new file, linked
      to it. Test.
- [x] T011 SQL (get/set RPCs, default 'ask') + account-settings UI select (ask / delete too / keep). Account setting `transcript_delete_prompt` (default `ask`): migration + `get`/`set`
      RPCs; surface in account settings UI.
- [x] T012 delete flow (row-menu trash of a video asks, with remember + account setting; verified live). Delete flow: when trashing a video with a companion and the setting is `ask`, the UI
      asks "Delete the transcript too?" with a remember checkbox; on confirm, trash both; the
      checkbox writes the setting. `drive-ops/trash` gains an optional `includeCompanion` flag.
      Test the SQL and the dialog.

## Phase 4 — Landing preview lifecycle

- [x] T013 Cascade: trashing a landing marks its `team_landing_renders` stale/removed so no
      render is served or counted (FR-L1). Migration + test.
- [x] T014 "Re-generate preview" (row menu; side-card variant later) in the side card and row actions (FR-L2): invalidate + requeue
      via the existing render loop. UI + test.
- [x] T015 confirmed (optimized landing gets its own render via fingerprint; covered by findings J) landing's fingerprint already yields its own preview (FR-L3);
      add a regression test, no behaviour change expected.

## Phase 5 — The side card

- [x] T016 Transcript block (card shows Transcribe / Re-transcribe by companion state; copy/translation land with T006) in `PreviewPane`: primary "Copy transcript" + overflow
      (re-transcribe / view translation / copy translation) when a companion exists; a single
      "Transcribe" when none. Compact, not a wall of buttons (FR-T8). Tests (jsdom).
- [x] T017 Card embeds `VideoTextActions` (variant selector + View + Copy + Re-transcribe); copy raises the green toast.
      `list_video_text_variants` now also surfaces the explorer transcript companion as the original variant, so translations held by the library appear with a selector.

## Phase 6 — Verify

- [x] T018 Ran the affected suites single-worker (again after the UI batch: 21 tests green) (team-companions-sql 10, team-preview-transcript, team-file-operations, creative-library-sidecars, team-share-button): all green.
- [ ] T019 (left for the owner's beta pass, 2026-10-11) Beta walkthrough on the real folder: transcribe a video, see the companion appear
      named after it; rename/move/trash and watch the companion follow; re-transcribe; delete a
      landing and confirm the render is gone; re-generate a preview. Record in `findings.md`.
