# Feature 012 — Media companions: transcripts that follow a video, previews that follow a landing

Status: draft (owner brief, 2026-08-30). Author: Soty. Branch base: `011-team-workspace-rework`.

## The ask, in the owner's words (condensed)

- Every video has **its own transcript** that "follows it like a tail". Transcribing mints a
  unique id linking the two. If one teammate transcribed it, everyone sees it ready — and can
  re-transcribe. Re-transcribing mints a new id and a new transcript, unlinks the old.
- When a video is acted on (compressed, copied, renamed), the transcript is **copied and named
  the same as the video**; a rename of the video renames the transcript. A move of the video
  moves the transcript. So each video owns one transcript that shadows its name and place.
- Deleting a video that has a transcript **asks** whether to delete the transcript too, with a
  "don't ask again" checkbox (default off); the answer is remembered (and editable in account
  settings). Deleting a transcript just deletes it.
- The side card shows: copy transcript / re-transcribe (when one exists), view rough
  translation / copy translation, or "transcribe" below when none exists — but **not as a wall
  of buttons**; present it sensibly.
- Landings: the local viewer makes a preview; everyone then opens the preview instantly. The
  first is made automatically on open. Re-generate from the card or the actions. An optimized
  landing is a different one, so it gets its own preview. Deleting the landing deletes the
  preview.

## What already exists (analysis)

| Piece                  | State today                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript **content** | Stored as columns on the video row (`team_materials.transcript_text`, `transcript_ingest_state`, `transcript_source_checksum`, `transcript_source_version`). Ingested by the agent (`apps/agent/src/team-bridge/process.ts`, `library.ts`) and committed via `service_commit_catalog_transcript`. |
| Transcript **files**   | Separate `.txt` materials of kind `transcript` also exist in the catalog (7 in the beta folder), independent of the columns.                                                                                                                                                                      |
| Landing **preview**    | `team_landing_renders` keyed by `(material_id, preset, fingerprint, source_version, source_checksum)`; auto-rendered on open, invalidated when the source changes; re-render loop on the agent. Sections G/J of feature 011.                                                                      |
| Lineage                | `catalog-search` exposes `lineage.hasSource / hasDerivatives / isVersion` per material — a linkage primitive already parsed by the UI.                                                                                                                                                            |
| Delete preference      | `set_share_preference` / `reset_share_preference` show the pattern for a remembered per-space choice; there is no per-account "ask on transcript delete" yet.                                                                                                                                     |

**Decision (owner's final update wins):** a transcript is a **first-class companion material**,
one per video, 1:1 — not a shared record. Deduplication happens only at _compute_ time: if an
identical audio fingerprint was transcribed before, its text is copied rather than recomputed,
but each video still owns a distinct transcript companion named after it. This makes rename,
move, copy and delete "follow the tail" trivial, and removes the shared-reference special case
the owner first described and then dropped.

## Functional requirements

### Transcripts

- **FR-T1** A video may have at most one **transcript companion** — a `transcript` material
  linked to the video by a stable `companion_of` reference and a `companion_kind = 'transcript'`.
- **FR-T2** Transcribing a video: the agent produces text and an **audio fingerprint** (a hash of
  the decoded audio, not the container, so a re-wrapped/compressed copy matches). The server
  creates the companion, names it after the video (`<video-stem>.txt`), places it beside the
  video, and records the fingerprint. If a companion with the same fingerprint already exists in
  the space, its text is copied instead of recomputed (compute-time dedup), but a **new** companion
  is still created for this video.
- **FR-T3** A companion carries its own id; re-transcribing mints a new companion (new id, new
  fingerprint), unlinks and trashes the old one, and links the new.
- **FR-T4** Any teammate sees a ready transcript the moment it exists (it is a catalog material,
  already realtime). Any teammate with `process` permission may re-transcribe.
- **FR-T5** Renaming a video renames its transcript companion to match (`<new-stem>.txt`). Moving
  a video moves the companion into the same destination. Copying/compressing a video that has a
  companion copies the companion too, named after the new file.
- **FR-T6** Deleting a video that has a companion asks: "Delete the transcript too?" with a
  "don't ask again" checkbox (default off). The answer, when the box is checked, is stored per
  **account** and honoured silently thereafter; it is editable in account settings. Because
  companions are 1:1, there is no shared-reference exemption.
- **FR-T7** Deleting a transcript companion directly just trashes it and unlinks the video.
- **FR-T8** The preview side card presents transcript actions compactly: when a companion exists,
  a primary "Copy transcript" and an overflow for "Re-transcribe", "View translation", "Copy
  translation"; when none exists, a single "Transcribe" affordance lower in the card.

### Landing previews

- **FR-L1** Deleting a landing trashes its preview renders (cascade), so an orphaned render is
  never served or counted.
- **FR-L2** The side card and the row actions offer "Re-generate preview" for a landing that has
  one; it invalidates the current render and requeues.
- **FR-L3** An optimized (re-processed) landing has a different fingerprint and therefore its own
  preview automatically — no code change beyond confirming the fingerprint already covers it.

## Non-goals / deferred

- Full-order server-side sort of a folder larger than one page (tracked from feature 011 §O).
- Translation _generation_ is out of scope; "view/copy translation" surfaces an existing
  translation variant if the library already holds one, otherwise the control is hidden.
- Cross-space dedup; fingerprint dedup is within a space.

## Success criteria

- SC-1: Transcribing a video creates a `.txt` companion named after it, beside it, linked; a
  second identical video transcribed reuses the text without a second agent run but gets its own
  companion.
- SC-2: Rename/move/trash of a video is mirrored by its companion; trash asks once (or never,
  per the remembered choice).
- SC-3: Deleting a landing leaves no render row in `ready`/`rendering`.
- SC-4: Re-generate preview produces a fresh render and the tile shows it.
