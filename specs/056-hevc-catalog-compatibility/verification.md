# Local qualification and integration handoff

Branch: `work/next-release-improvements`, integration source base `895fa7f7`.
Implementation is locally qualified; final combined release verification belongs to
integration. This record authorizes no deployment or production data write.

## Native engine and common variants

Executed on macOS ARM with the exact shipped FFmpeg7.1.1 binaries at
`release/beta/Soty Beta.app/Contents/Resources/runtime/bin/`:

- ffmpeg SHA256: `2a1ea219bd952fabaf858a070f231f31f7bacfd06c5215a62bd416c3eaf56178`
- ffprobe SHA256: `82c5020f737a87410c0888623ebd1235cb3afc08dcdb2bbe100a27aa4e5c151e`

Real synthetic Main8/no-audio, Main10 SDR/AAC, PQ10, HLG10, VFR30→15fps,
rotated hev1 MOV and actual automatic-frame restitch delegate all pass.
PQ/HLG neutral pixel values match an independent transfer/shoulder reference;
orientation, square pixels, CFR packet cadence, duration/audio, SDR metadata,
strict full decode and unchanged original hashes are checked. Ten native
consumers start one encode; first-consumer cancellation and source removal do
not invalidate the other nine. Native H.264 preparation retains its fast path.

Independent cache tests cover last-cancellation cleanup barriers, cancellation
during actual source/cache hash streams, changed producer isolation, wrong input
revision, cache corruption, restart leftovers, changed recipe, disk pressure,
a malformed older cache directory, failed producer and retry. Neither partial
work nor a cancelled validation is permission to publish/delete a verified entry.

## Focused commands and results

The following command passed198 tests in18 files, with zero failures/skips
and97.33% line coverage over the four explicitly selected new product modules:

```bash
FFMPEG_PATH='/Users/daynero/RiderProjects/AffSupport/release/beta/Soty Beta.app/Contents/Resources/runtime/bin/ffmpeg' \
FFPROBE_PATH='/Users/daynero/RiderProjects/AffSupport/release/beta/Soty Beta.app/Contents/Resources/runtime/bin/ffprobe' \
nice -n 15 npx vitest run \
  tests/hevc-native.test.ts tests/hevc-source-cache.test.ts tests/hevc-color.test.ts \
  tests/hevc-journal.test.ts tests/catalog-video-replacement.test.ts \
  tests/catalog-video-replacement-analytics.test.ts tests/catalog-video-replacement-ui.test.tsx \
  tests/material-rename-preview.test.ts tests/browser-download-isolation.test.ts \
  tests/team-bridge.test.ts tests/team-restitch-prepare.test.ts tests/team-restitch-delegate.test.ts \
  tests/restitch-shared-inspection.test.ts tests/restitch-multi-variation-reuse.test.ts \
  tests/team-operation-recovery.test.ts tests/analytics-code-map.test.ts \
  tests/run-state-coverage.test.ts tests/suite-hygiene.test.ts \
  --maxWorkers=1 --no-file-parallelism --coverage \
  --coverage.reportsDirectory=/tmp/soty-improvements-coverage \
  --coverage.include=apps/agent/src/stitcher/hevc-color.ts \
  --coverage.include=apps/agent/src/stitcher/hevc-normalize.ts \
  --coverage.include=apps/agent/src/stitcher/verified-source-cache.ts \
  --coverage.include=packages/shared/src/team/catalog-video-replacement.ts
```

| Module                       | Measured line coverage | New critical floor |
| ---------------------------- | ---------------------: | -----------------: |
| hevc-color.ts                |                   100% |                  — |
| hevc-normalize.ts            |                 97.91% |                  — |
| verified-source-cache.ts     |                 96.12% |                  — |
| catalog-video-replacement.ts |                 96.73% |                95% |

The later delayed-delivery regression passed the complete5-test HEVC journal
file with the same shipped-engine environment and single-worker flags. It proves
that a completion received after as-of is excluded. Actual normalization records
pass browser privacy validation, real `ingest_agent_journal`, the migration-owned
`wishly_analytics_ro` role and CLI `inspect` by operation, attempt and shared ID.
Separate per-call attempt IDs prevent an earlier completed material from masking
a later unfinished preparation. Missing, conflicting, truncated and delayed
signals remain unknown. Local ready never becomes a catalog-delivery terminal.

Canonical serial static checks:

```bash
SOTY_VERIFY_SERIAL=1 nice -n 15 npm run verify -- --gates=static
```

The first run passed all gates except lint; caught cancellation errors gained
internal causes, generator Node globals gained explicit imports, then
`nice -n 15 npm run lint` passed. The final canonical rerun passed all15 gates in107 seconds. A final
storage-event scope guard then passed targeted lint, formatting and the full
replacement UI/mutation-journal tests; unrelated cross-tab settings cannot
restart its bounded retry burst. No static gate exemption was added.

## Catalog replacement and earlier requested fixes

Replacement preserves the existing document, products, IDs and nonvideo cells;
only verified video cells/binding and optional catalog-only parent placement
change. Lost move responses are read back under the existing publication lane.
Pending/unresolved work stays fenced; SOURCE_CHANGED remains specific through
manual row-ID edits. The dialog defaults to moving the catalog to the new video
folder and uses bounded automatic serial reconciliation, without replaying writes.

Actual-picker Chrome QA at1280×900 and390×844 verified long-name selection,
no document/dialog horizontal overflow and automatic confirmed success. Evidence:
`/tmp/catalog-replace-desktop.png`, `/tmp/catalog-replace-mobile.png`.
The isolated harness blocked external requests and was removed; its Vite and
Chrome processes were stopped. Earlier tag-manager desktop/mobile/edit evidence:
`/tmp/soty-tags-desktop.png`, `/tmp/soty-tags-mobile.png`,
`/tmp/soty-tags-edit-mobile.png`, `/tmp/soty-tags-final.png`.

The branch also keeps the catalog manager visible, splits task/transcription
preferences, makes both tag dictionaries compact/scrollable with visible actions,
preserves a known unchanged thumbnail across rename and isolates browser downloads
from workspace navigation. Native single/workspace transcription regressions survive
independent completed/cancelled downloads. The exact originally reported download
incident was not reproduced or attributed to a specific production user; these
checks establish the isolation boundary, not a proven historical root cause.

Replacement SQL previously passed the full isolated local database command:
76 pgTAP files1500 assertions,3 auth and84 native =1587 passed. The migration
has not changed since that run. Focused real PostgreSQL command-concurrency and
provider fixture tests remain separate from live Google acceptance.

## Limits and remaining release evidence

- ARM execution is not Windows/Intel execution or physical hardware playback proof.
- No Dolby Vision enhancement-layer fixture is present. Compatible PQ/HLG base
  layers use this recipe; profile5/ICtCp, corrupt, encrypted or non-decodable
  special streams fail explicitly rather than receiving false colours.
- First HEVC conversion requires a full encode, can take longer and increase size;
  verified later consumers reuse it. Original files are retained.
- Replacement requires the verified immediate-publication baseline and one Drive
  connection. Existing spare/uncancelled variation/unresolved jobs must settle
  through their ordinary controls; legacy/held/future publications are refused.
- Packaged beta, live Google acceptance, complete combined build/suite/database
  gates, Windows/Intel release evidence and deployment remain integration work.
