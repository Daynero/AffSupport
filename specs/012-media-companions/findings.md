# Findings — feature 012 (media companions)

## Foundation laid, 2026-08-30 (autonomous run)

Built and verified the parts that can be done reliably and tested without a whisper run on a
loaded machine. Each is its own commit on `011-team-workspace-rework`.

### Done and tested

| Task | What shipped | Proof |
| --- | --- | --- |
| T001 | `companion_of` / `companion_kind` / `audio_fingerprint` on `team_materials`; one live transcript companion per video; content-fingerprint index | `tests/team-companions-sql.test.ts` |
| T002 | `get_material_transcript_companion` — a video's transcript, for a member | same |
| T005 (SQL) | `service_link_transcript_companion` (link + retire the old + keep transcript identity consistent) and `service_find_transcript_by_fingerprint` (compute-time dedup) | same, incl. the re-transcribe replacement |
| T013 | A trashed landing stops serving its preview: `list_landing_renders` now requires an active material | same |
| T014 | "Перегенерувати превʼю" from the row menu → `request_landing_render_refresh` marks the render stale for the loop | live (RPC 200, render → stale) + test |
| T015 | Confirmed: an optimized landing already gets its own preview by fingerprint (feature 011 §J) | — |

So **Phase 1 (data model) and Phase 4 (landing preview lifecycle) are complete**, and the SQL
half of the transcribe→companion path is in.

### Added after the machine freed up (T006, T016, T014, landing lifecycle)

- **T006** the transcription finalize now links its `.txt` as the video's transcript companion
  (`service_link_transcript_companion`, best-effort; drive-ops recompiles and serves). The
  transcript output is named after the video (`<stem>.txt`, FR-T2). End-to-end verification
  needs a whisper run — the model here is `ggml-large-v3`, minutes of CPU on this machine, so
  it was not run live; the wiring is a simple call to the SQL function already covered by
  `tests/team-companions-sql.test.ts`.
- **T016** the video side card shows a Transcript block, and the card's Transcribe preselects
  the transcription tool (`initialTool`).

### Verified end-to-end, live (2026-08-30)

Transcribed the smallest real video (4.68 MB) through the card. whisper (`ggml-large-v3`) ran
on the agent, the operation reached `succeeded`, and a transcript companion appeared: a
`.txt` **named after the video** (`<stem>.txt`, FR-T2), `category=transcript`, linked
(`companion_of`), `ingest_state=full`, text indexed. The card then showed **"Перетранскрибувати"**.
So T006 (finalize→companion), T005 (link) and T016 (card state) all work against a real
whisper run — the core of the feature is proven, not just unit-tested.

### Still not done blind (needs a free machine + a real whisper run)

The rest forms one coupled block that touches the working `drive-ops` mutation handlers (which
cannot be type-checked locally without Deno) and can only be judged by transcribing a real
video — heavy on this machine (load was 7–8 during the run, beta cron + agent). Shipping it
unverified would risk the move/rename/trash/process paths that were just repaired.

- **T004** agent audio fingerprint (ffmpeg → PCM → sha256).
- **T006** finalize wiring: a transcription result becomes a companion via T005 instead of a bare `.txt`.
- **T007** re-transcribe (force a new companion).
- **T008–T010** the tail: rename / move / copy-compress carry the companion.
- **T011–T012** the `transcript_delete_prompt` account setting and the delete-with-companion dialog.
- **T016–T017** the side-card transcript block (copy / re-transcribe / translation), which only
  shows its full self once T006 makes companions real; today it would show only "Transcribe".

### How to resume

1. On a machine with headroom and whisper installed, do T004 then T006 — that alone makes
   companions appear when a video is transcribed, and the side card (T016) becomes meaningful.
2. Then the tail (T008–T010) and the delete flow (T011–T012), each with its SQL test and one
   live check on the reference folder (`quickstart` in the 011 spec), recording here.

### T012 delete-with-companion, verified live (2026-08-30)

Trashing a video that has a transcript companion now asks "Видалити також транскрипцію?" with
a "Більше не запитувати" checkbox and Delete/Keep — verified on screen: the video went to the
trash and the dialog appeared over the list. The dialog lives in `ExplorerShell`, not the row
(which unmounts the instant the video leaves the list — an earlier attempt in `RowActions` was
destroyed before it could show). The account setting (`transcript_delete_pref`) backs the
checkbox and skips the question thereafter. Deleting the companion runs an ordinary trash.
