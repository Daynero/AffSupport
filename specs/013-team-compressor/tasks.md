# Tasks — feature 013 (team compressor)

Machine rule as ever: `uptime` before builds, one heavy thing at a time,
vitest single-worker, live-verify each phase in the beta browser.

## Phase A — embedding activity + name endings (both compressors)

- [ ] A1 `ImageEmbeddingSettings.disabledImageIds: string[]` in shared types +
      agent settings-validation + persisted defaults. Random image pick (where
      the queue drafts the job's embedding) excludes disabled ids; a slot with
      only disabled images counts as absent.
- [ ] A2 `ImageEmbeddingSection`: click an image → toggle in `disabledImageIds`.
      Inactive: grayscale + translucent full-tile cross + ~20% gray veil.
      Active: normal + green outline with a soft glow. Delete button unchanged.
      CSS + jsdom test.
- [ ] A3 Local compressor name endings: a suffix field in OutputSettings
      (`AgentSettings.outputSuffix: string | null`); `nextOutputPath` uses
      `<stem><suffix>[_N].mp4` when set, the historic `_compressed[_N]`
      otherwise. Validation + test.

## Phase B — the team compressor dialog + queue

- [ ] B1 Generalize the explorer's background queue to carry
      `{tool, options, output}` items (transcription stays as-is; compressor
      jobs join the same line and panel).
- [ ] B2 `TeamCompressorDialog`: compact settings (optimal/custom-lite,
      embedding toggle reusing the agent's cached images, suffix field,
      destination). Entry points: file's Обробити → Компресор preselect,
      selection bar (each selected video), folder's Обробити вміст…
      («Стиснути всі відео»).
- [ ] B3 Destination «Поруч з оригіналом» / «У папку на Drive» (folder picker):
      start the process with the right `destinationFolderId` + suffixed
      `outputName` (`_1`, `_2` numbering when the suffix is empty).
- [ ] B4 Destination «Перезаписати оригінал»: run as `new_version` of the
      source material (same id → companions stay), name preserved (or
      `name+suffix` → rename in the same commit), modified date updates;
      the original is untouched until the upload finalizes. Server work in
      `drive-ops/process/*` to accept a `versionOfMaterialId`.
- [ ] B5 Destination «Локально на компʼютері»: the agent also writes the
      result into its chosen local folder (reuse `outputMode: 'chosen-folder'`
      plumbing) — surfaced as a checkbox/choice in the dialog.

## Phase C — verify

- [ ] C1 Suites single-worker; beta walkthrough: compress-to-beside with and
      without suffix, overwrite keeps id+companion+name, disabled image never
      picked, batch over a selection through the corner panel.
