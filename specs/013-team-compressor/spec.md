# Feature 013 — The compressor inside the team space

Status: draft (owner brief, 2026-08-30). Branch base: `011-team-workspace-rework`.

## The ask, in the owner's words (condensed)

- Pick a folder, a file, or several selected files → Обробити → Компресор → a
  compact settings window, by analogy with the existing local compressor.
- **Where the result goes** — three choices:
  1. beside the original (default);
  2. into a chosen folder — **on Drive or locally on the computer**;
  3. **overwrite the original** — the replacement happens only after a
     successful compression, the name stays the same, every attached
     transcript stays attached to the new file, the modified date updates.
- **Name suffix**: a field, e.g. `(перезашив)`, appended to the created file's
  name — even when "overwrite" was chosen (the file is replaced but renamed to
  `old name + suffix`). Empty field → default numbering `_1`, `_2`, … (only for
  non-overwrite; a plain overwrite keeps the exact name).
- The embedding images / prefixes work like the regular compressor and are
  cached (the agent already persists them) so nothing is re-picked each time.
- **New in BOTH compressors** (team and the main one):
  - the default/custom name endings above;
  - every embedding image has a delete button (exists), and **clicking the
    image itself toggles it inactive**: grayscale, a translucent cross over the
    whole image, ~20% gray blur — excluded from the random pick; active images
    show as-is with a green outline and a small glow.

## What exists (analysis)

| Piece | State |
| --- | --- |
| Team process pipeline | `drive-ops/process/start` → agent `/api/team/process` → `compressionDelegate` (queue.addTeamUploaded) → finalize commits the output as a new material. `options` passes an `AgentSettingsPatch` (mode, crf, resolution, imageEmbedding…), `parseSettingsPatch`-validated; output always lands as `outputName` in `destinationFolderId`. |
| Overwrite primitive | The operation kind `new_version` + `replaceMaterialId`/`versionOfMaterialId` in the upload conflict plan; finalize accepts `upload`/`new_version`/`process`. Replacing a material keeps its id → companions stay attached by construction. |
| Local compressor | `SettingsPanel` (mode/custom, output next-to-originals / chosen folder, metadata, `ImageEmbeddingSection`); naming via `nextOutputPath` → `<stem>_compressed[_N].mp4`. Settings live on the agent (persisted), images in `ImageAssetStore` — this *is* the cache the owner wants. |
| Embedding assets | `ImageAsset {id,fileName,…}` uploaded via `/api/images/:slot`; a random one per job via `draftImageEmbedding(settings.imageEmbedding)`. No per-image active flag today. |

## Functional requirements

### A. Both compressors — embedding + naming

- **FR-A1** `ImageEmbeddingSettings` gains `disabledImageIds: string[]`.
  `draftImageEmbedding` never picks a disabled image; a slot whose images are
  all disabled counts as empty. Settings-patch validated, persisted by the
  agent like the rest.
- **FR-A2** In `ImageEmbeddingSection`, clicking an image toggles it: inactive
  renders grayscale with a translucent full-size cross and a light gray veil
  (~20%), active renders normally with a green outline and a small glow. The
  delete button stays.
- **FR-A3** Output-name suffix, both compressors: a text field; empty means
  the current behaviour (`_compressed[_N]` locally; `_1`, `_2` numbering in
  the team dialog); non-empty means `<stem><suffix>.mp4` (collision → `_2`…).

### B. Team compressor

- **FR-B1** Compressor from: a single file's Обробити, the selection bar's
  Обробити (each selected video), and the folder's Обробити вміст…
  ("Стиснути всі відео"). All feed the one background processing queue
  (012's transcription queue generalized to carry a tool + options).
- **FR-B2** A compact dialog: quality (optimal/custom-lite), embedding on/off
  (uses the agent's cached images/settings), the suffix field, and the
  destination choice:
  - «Поруч з оригіналом» (default);
  - «У папку…» → the folder picker (Drive), or «Локально на компʼютері…» →
    the agent's chosen-folder flow (result also saved to that local folder);
  - «Перезаписати оригінал» — runs as a `new_version` of the source material:
    committed only on success, same material id (companions stay), same name
    (or `name+suffix` when the suffix field is filled), modified date updates.
- **FR-B3** Overwrite safety: the source is never touched until the compressed
  file is fully uploaded; a failed run leaves the original as it was.

## Success criteria

- SC-1: compress-to-beside creates `<stem>_1.mp4` (or `<stem>(суфікс).mp4`)
  next to the source; transcripts of the source stay with the source.
- SC-2: overwrite keeps the material id and name, the transcript companion
  still opens from the video's card, `modifiedAt` is fresh.
- SC-3: a disabled embedding image is never chosen across many runs; the
  toggle survives an agent restart.
- SC-4: the queue runs N selected videos one by one with the corner panel.
