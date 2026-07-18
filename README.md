# Local Video Compressor — macOS

A private local video compressor controlled from a browser. Videos are selected with native macOS dialogs, processed by the Mac's system FFmpeg, and never uploaded.

## Run

Developer requirements: macOS, Node.js 22+, and FFmpeg/FFprobe. Testers using the packaged app need none of these.

```bash
npm install
npm run build
npm start
```

The agent listens only on `http://127.0.0.1:43120` and opens its matching bundled interface automatically. Development mode is `npm run dev` with the fixed `http://127.0.0.1:5173` origin.

## Hosted closed test

Cloudflare Pages needs no backend or Functions: videos are selected through the local agent and never enter the web build. The current `local-video-compressor-test` Pages project uses Direct Upload, so pushing GitHub does not deploy it. The production environment sets only the loopback Agent URL; the immutable, versioned download URL comes from `packages/shared/src/release.ts`. The included `_redirects` supplies SPA fallback and `_headers` prevents a stale HTML shell while keeping hashed assets immutable.

Before packaging, obtain matching standalone Apple Silicon FFmpeg and FFprobe from a reviewed, reproducible distribution; record version, configure flags, license, source URL and checksums in `THIRD_PARTY_NOTICES.md`. Homebrew-linked binaries are rejected. Then run:

```bash
PUBLIC_SITE_ORIGIN=https://YOUR-PROJECT.pages.dev \
FFMPEG_BINARY=/approved/ffmpeg FFPROBE_BINARY=/approved/ffprobe \
FFMPEG_SOURCE_ARCHIVE=/approved/ffmpeg-7.1.1.tar.xz \
X264_SOURCE_ARCHIVE=/approved/x264-source.tar.gz \
npm run package:mac
npm run verify:package
```

All five variables are required; `scripts/package-mac.sh` aborts if any is missing. Release packaging also requires a clean committed worktree and refuses to overwrite an artifact with the same build identity. This creates the ad-hoc-signed app and a versioned backup ZIP. Run `npm run package:dmg` to create the versioned DMG and SHA-256 file shown by `npm run release:info`. Do not commit `release/`.

### Release and compatibility policy

`packages/shared/src/release.ts` is the single release manifest. Use these rules for every published change:

1. Increment `PRODUCT_VERSION` and the monotonically increasing numeric `BUILD_NUMBER` for every published Agent build. Keep the build number to at most three period-separated integer components as required by macOS. A GitHub tag or asset is never replaced in place.
2. Increment `AGENT_API_VERSION` only for a breaking web/Agent contract change. Keep `MIN_SUPPORTED_AGENT_API_VERSION` and `MAX_SUPPORTED_AGENT_API_VERSION` at the actual range the web UI supports.
3. Update all workspace package versions to `PRODUCT_VERSION`; `npm run release:check` verifies the identity, API range, tag, artifact URL, and manifests.
4. From a clean commit, run `npm run package:mac`, `npm run verify:package`, `npm run package:dmg`, and `npm run verify:dmg`.
5. Create the new tag on that exact commit and publish the uniquely named DMG and checksum. Packaging aborts if the tag is already present locally or on `origin`, so a published release cannot be rebuilt in place.
6. Only after the Agent asset is reachable, run `npm run deploy:web`; deployment requires the tag at `HEAD` and aborts if that exact versioned Agent asset is unavailable.

The packaged launcher opens the web UI bundled inside the same `.app`, so its UI and API contract are always atomic. The hosted page remains useful for onboarding and remote pairing. If it encounters an older Agent, it offers the bundled local interface immediately as a safe fallback; if it encounters a newer Agent, it asks to refresh the page instead of incorrectly requesting an Agent downgrade.

Starting with `0.2.0-test.1`, the launcher also watches the installed release manifest. When a newer `.app` replaces the running copy, it performs a version-aware handoff after active compression completes. Migrating from the legacy `0.1.0-test` build requires one manual quit because that old launcher predates the handoff protocol.

This test build is **ad-hoc signed, not Apple-notarized**. macOS quarantines it after download and Gatekeeper will not launch it directly (there is no "Open Anyway" affordance for an ad-hoc signature). Testers must run `xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"` after installing each downloaded build — see `TESTER_GUIDE.md`. A production release requires a Developer ID Application certificate, `--options runtime` hardened signing, and Apple notarization + stapling, after which no such step is needed. Intel/Universal support has not been verified and is not claimed.

## Daily use

1. Keep the default **Optimal** mode, or open **Custom settings** for FPS, longest-side resolution, and CRF or target bitrate.
2. Keep **Next to originals**, or use **Separate folder** for a native folder dialog.
3. Add videos with the native picker or by dropping files onto the drop zone.
4. Select rows with their checkboxes and choose **Compress selected**. New videos can be added while the queue runs.
5. Use Cancel, Remove, Try again, Clear finished, Show in folder, Open, or Show output folder as needed.

The app warns before adding an `_compressed` file or a duplicate already represented in the queue. The user can explicitly confirm either case.

### Size estimates

New ready videos are estimated automatically, one at a time, by the local agent. The estimate uses short FFmpeg samples spread across the full timeline (including the beginning, 20/40/60/80%, and near the end), the exact per-job encoding snapshot, source audio information, and a small container allowance. Short videos may be sampled in full because that is both fast and more reliable.

An estimate is explicitly marked with `Estimated` and `≈`; it is not a guarantee. The tooltip shows a likely range because CRF output depends on scene complexity. Starting real compression immediately stops automatic estimation first, so the real encode never waits for all estimates and the two FFmpeg workloads do not run together. While compression is active, a queued file waiting for an estimate has a compact priority button. It pauses the current FFmpeg encode without discarding progress, runs prioritized estimates in click order, then resumes that same encode. A prioritized request can be cancelled before or during its estimate. After compression, the factual before/after size replaces the forecast.

Each video shows source size, resolution, frame rate, bitrate, duration, and codec. Changing any custom encoding control clears ready-job forecasts and schedules a debounced recalculation. Results are cached locally using absolute path, file size, modification time, the complete encoding snapshot, and algorithm version. The cache is capped at 300 recent entries. Temporary sample files are removed after success, failure, cancellation, and agent shutdown.

### Compression modes

- **Optimal** (default): H.264 CRF 26, original resolution, original frame rate, copied audio when compatible, and controlled AAC 96k fallback.
- **Custom settings:** original or explicit FPS, original or explicit longest-side resolution, and one active rate-control method: CRF 16–35 or target video bitrate. CRF and bitrate are never sent together.

Scaling preserves aspect ratio for horizontal and vertical video, makes the calculated side even, and never upscales. Every mode produces an H.264 MP4 with yuv420p pixels and fast-start metadata.

## Files, state, and safety

Results use `name_compressed.mp4`, then `_compressed_2`, `_compressed_3`, and so on. FFmpeg receives `-n`, so an existing result is never overwritten. Originals are never modified or deleted.

Settings and queue metadata are stored locally at:

```text
~/Library/Application Support/Local Video Compressor/state.json
```

Estimate cache: `~/Library/Application Support/Local Video Compressor/estimate-cache.json`.

Closing or reloading the browser does not stop processing. Restarting the agent restores the queue; a job that was processing becomes **interrupted** and can be retried from the beginning. Partial output from an abrupt OS/process termination may remain on disk and is never overwritten; retry chooses the next safe filename.

Before starting, the agent conservatively compares free space in every relevant output folder with the original sizes. An obvious shortage produces a warning but never changes the originals.

## Local API

Every `/api/*` route requires a random per-process 256-bit token. The token is issued only through the `/pair` redirect (production origin) or `/local` (bundled loopback UI), which place it in the page URL fragment. The unauthenticated `/health` route exposes only readiness, release/API identity, instance start time, and busy state so the packaged launcher can perform safe handoff. CORS permits only the production page and fixed local development origin. Request bodies are structurally validated, encoding parameters are defined only in the agent, and every external process uses argument arrays with `shell: false`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Unauthenticated readiness probe used by the launcher |
| GET | `/pair`, `/local` | Redirect to the site with a fresh session token |
| GET | `/api/health`, `/api/queue`, `/api/diagnostics` | Obtain current state and diagnostics |
| GET | `/api/events` | Live SSE queue snapshots |
| POST | `/api/files/select`, `/api/files/confirm`, `/api/files/upload` | Native selection, drop upload, and explicit warning confirmation |
| POST | `/api/settings`, `/api/output/select` | Compression/output settings and native folder selection |
| POST | `/api/queue/start` | Start selected ready jobs as a sequential batch |
| POST, DELETE | `/api/jobs/:id/estimate-priority` | Queue or cancel an immediate size estimate during compression |
| POST | `/api/jobs/:id/cancel`, `/retry`, `/reveal`, `/open` | Manage one job |
| POST, DELETE | `/api/jobs/remove`, `/api/jobs/:id`, `/api/jobs/completed` | Remove selected rows or clear finished rows without deleting outputs |
| POST | `/api/output/reveal` | Open an available output folder |

## Troubleshooting

- **Agent unavailable:** keep the `npm start` terminal open and reload the page.
- **Missing FFmpeg/FFprobe:** install with `brew install ffmpeg`, then restart.
- **Permission denied:** allow Terminal/Node access in macOS Privacy & Security and choose a writable folder.
- **Disk warning:** free space on the output volume. CRF output size cannot be predicted exactly.
- **Unsupported/damaged video:** the failed card remains retryable and the next queued file still runs.
- Technical diagnostics remain in the local terminal log; video contents are never logged.

## Current limitations

- macOS Apple Silicon only. A packaged `.app` and drag-to-Applications DMG exist (`npm run package:dmg`), but the test build is ad-hoc signed, not notarized, so it needs the quarantine step after each downloaded build. Updating still requires replacing the app manually; restart/handoff after replacement is automatic from `0.2.0-test.1` onward.
- One local agent and one FFmpeg encoding process at a time.
- Retry restarts a file from the beginning; there is no partial resume.
- State is local JSON, not a multi-user database. Source files moved after selection will fail clearly.
- “Show output folder” opens one relevant folder; jobs saved beside originals may span several folders, while each card can reveal its exact result.
