# Tasks — feature 013 (team compressor)

Machine rule as ever: `uptime` before builds, one heavy thing at a time,
vitest single-worker, live-verify each phase in the beta browser.

## Phase A — embedding activity + name endings (both compressors)

- [x] A1 `ImageEmbeddingSettings.disabledImageIds: string[]` in shared types +
      agent settings-validation + persisted defaults. Random image pick (where
      the queue drafts the job's embedding) excludes disabled ids; a slot with
      only disabled images counts as absent.
- [x] A2 `ImageEmbeddingSection`: click an image → toggle in `disabledImageIds`.
      Inactive: grayscale + translucent full-tile cross + ~20% gray veil.
      Active: normal + green outline with a soft glow. Delete button unchanged.
      CSS + jsdom test.
- [x] A3 Local compressor name endings: a suffix field in OutputSettings
      (`AgentSettings.outputSuffix: string | null`); `nextOutputPath` uses
      `<stem><suffix>[_N].mp4` when set, the historic `_compressed[_N]`
      otherwise. Validation + test.

## Phase B — the team compressor dialog + queue

- [x] B1 Generalize the explorer's background queue to carry
      `{tool, options, output}` items (transcription stays as-is; compressor
      jobs join the same line and panel).
- [x] B2 `TeamCompressorDialog`: compact settings (optimal/custom-lite,
      embedding toggle reusing the agent's cached images, suffix field,
      destination). Entry points: file's Обробити → Компресор preselect,
      selection bar (each selected video), folder's Обробити вміст…
      («Стиснути всі відео»).
- [~] B3 Destination «Поруч з оригіналом» / «У папку на Drive» (folder picker):
      start the process with the right `destinationFolderId` + suffixed
      `outputName` (`_1`, `_2` numbering when the suffix is empty).
- [~] B4 Destination «Перезаписати оригінал»: run as `new_version` of the
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

## Findings while building (2026-08-30)

- A1–A3 shipped and live-verified (tile toggle incl. reload persistence on the
  rebuilt agent; suffix field; pictogram fit control) — 14/14 suite green.
- B1–B3: the generalized background queue carries compressor jobs; the compact
  dialog (embed toggle, suffix, three destinations) opens from the selection
  bar and the folder batch dialog. First live run compressed the real
  16-tail.mp4 through the corner panel.
- B4 server path written: `process/start` accepts `versionOfMaterialId`
  (= its own source), the intent carries it, and `process/output/start`
  uploads onto the source's Drive file id — finalize's
  on-conflict-by-drive-file-id update refreshes the same material row, so the
  id, companions and name survive and `modifiedAt` moves. Awaiting live proof.
- Debug tale: three straight 404s on process/start turned out to be a
  synthetic seed row (uuid-named fd5e….mp4, no such file in Drive) — the
  server's proveContext gets Drive's 404 and maps it to NOT_FOUND. Real files
  pass. A macOS ML-indexing storm (load >100) also made edge isolates die
  mid-request, which produced the earlier transient 404s.
- Iconography direction (owner): lucide-react (ISC, SF-Symbols-spirit thin
  outlines) is now the app's icon system; anything missing is hand-drawn in
  the same convention (24px, stroke 2, round caps, outlines only — no fills).
  The fit trio was redrawn accordingly after the filled version read as a
  battery gauge.

### B3 proven live; the 75%-stall root cause (2026-08-30)

Every team compression died at uploading/75% while 3 KB transcripts always
passed. Cause (caught by unwrapping undici's error.cause on the agent):
Google's resumable protocol answers **308 Resume Incomplete** for every
intermediate chunk, and undici treats 308 as a redirect — with
`redirect: 'error'` the first chunk of anything bigger than one chunk threw
"fetch failed <= unexpected redirect". Transcripts fit in the single final
chunk (200/201), so the bug hid behind them. Fix: `redirect: 'manual'` on the
chunk PUT — the loop already handles 308. First green run right after:
`16-tail_1.mp4` (default `_1` ending) landed beside the original, visible in
the explorer next to `16-tail.mp4` and its transcript.

Debug metho that got there: fetch-tap in the page caught the agent's 400
(only generic PROCESS_FAILED), then agent-side cause-chain logging named the
real reason. Also flushed along the way: a stray duplicate CSS rule kept the
tile delete at 10px; two stalled runs pinned the agent bridge (requests that
never complete) — restarting the agent releases it, and reservations were
freed by marking the dead operations failed.

## Live findings (session 2026-08-30, overwrite saga continued)
- The "75% hang with no connections" had TWO independent causes stacked:
  1. undici treats Google's 308 chunk acks as redirects (`redirect: 'error'`
     aborted multi-chunk uploads) — fixed with `redirect: 'manual'`.
  2. `docker restart supabase_edge_runtime_wishly` kills in-flight requests:
     an agent POST (process/fail, process/start) that hits the dying isolate
     never completes, leaving ops stuck `running/uploading/75` and the web
     queue silently dropping the click. Never redeploy edge while an op runs.
- `team_operations` rows must satisfy `terminal_time_check`: manual SQL
  cleanup needs `finished_at=now()` alongside `state='failed'`.
- Postgres in the container runs UTC; local monitors print UTC+3 — compare
  accordingly before declaring an op missing.
- finalize's `verifyBoundSource` threw SOURCE_CHANGED on overwrite runs
  (the run itself advances the source's drive version); drive-ops now skips
  the stale-source comparison when `versionOfMaterialId === sourceMaterialId`.
- The silent queue deaths had a third cause beyond edge restarts and HMR
  page reloads: `process/start` 409 NAME_CONFLICT swallowed by the web
  runner (no toast — worth fixing), and the 409 itself came from the name
  reservation unique index: succeeded MOVE operations finish through
  `service_complete_material_group_intent`, which never released
  `reservation_released_at` — the moved name stayed blocked in that folder
  forever. Fixed by 20260830190000 (release on success); stale held keys
  were released manually (trigger `TERMINAL_OPERATION_IMMUTABLE` requires
  a temporary `disable trigger user`).
- The finalize RPC needed real overwrite support (20260830180000): three
  checks — stale source version, "result must not be the source file",
  processed_from self-link — are skipped when
  `intent.version_of_material_id = operation.source_material_id`.
