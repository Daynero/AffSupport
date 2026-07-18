# Local Video Compressor — macOS

A private local video compressor controlled from a browser. Videos are selected with native macOS dialogs, processed by the Mac's system FFmpeg, and never uploaded.

## Run

Developer requirements: macOS, Node.js 22+, and FFmpeg/FFprobe. Testers using the packaged app need none of these.

```bash
npm install
npm run build
npm start
```

The agent listens only on `http://127.0.0.1:43120` and opens the paired website automatically. Development mode is `npm run dev` with the fixed `http://127.0.0.1:5173` origin.

## Hosted closed test

Cloudflare Pages needs no backend or Functions: videos are selected through the local agent and never enter the web build. The current `local-video-compressor-test` Pages project uses Direct Upload, so pushing GitHub does not deploy it. After `npx wrangler login`, publish a verified build with `npm run deploy:web`. The production values in `apps/web/.env.production` set the loopback Agent URL and release download URL; the included `_redirects` supplies SPA fallback. If another Pages project is used, update those values and build the Agent with that project's exact HTTPS origin.

Before packaging, obtain matching standalone Apple Silicon FFmpeg and FFprobe from a reviewed, reproducible distribution; record version, configure flags, license, source URL and checksums in `THIRD_PARTY_NOTICES.md`. Homebrew-linked binaries are rejected. Then run:

```bash
PUBLIC_SITE_ORIGIN=https://YOUR-PROJECT.pages.dev \
FFMPEG_BINARY=/approved/ffmpeg FFPROBE_BINARY=/approved/ffprobe \
FFMPEG_SOURCE_ARCHIVE=/approved/ffmpeg-7.1.1.tar.xz \
X264_SOURCE_ARCHIVE=/approved/x264-source.tar.gz \
npm run package:mac
npm run verify:package
```

All five variables are required; `scripts/package-mac.sh` aborts if any is missing. This creates the ad-hoc-signed app and backup ZIP. Run `npm run package:dmg` to create `release/LocalVideoCompressor-v0.1.0-test-macOS-arm64.dmg` and its SHA-256 file. Do not commit `release/`. Attach the DMG, checksum, optional ZIP, `TESTER_GUIDE.md`, `RELEASE_NOTES.md`, and the completed third-party notice to release `v0.1.0-test`.

This test build is **ad-hoc signed, not Apple-notarized**. macOS quarantines it after download and Gatekeeper will not launch it directly (there is no "Open Anyway" affordance for an ad-hoc signature). Testers must run `xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"` once after installing — see `TESTER_GUIDE.md`. A production release requires a Developer ID Application certificate, `--options runtime` hardened signing, and Apple notarization + stapling, after which no such step is needed. Intel/Universal support has not been verified and is not claimed.

## Daily use

1. Choose a compression preset.
2. Keep **Next to originals**, or use **Choose output folder** for a native folder dialog.
3. Select any number of videos and start compression. New videos can be added while the queue runs.
4. Use Cancel, Remove, Retry, Clear finished, Show in Finder, or Show output folder as needed.

The app warns before adding an `_compressed` file or a duplicate already represented in the queue. The user can explicitly confirm either case.

### Size estimates

New queued videos are estimated automatically, one at a time, by the local agent. The estimate uses short FFmpeg samples spread across the full timeline (including the beginning, 20/40/60/80%, and near the end), the selected preset, source audio information, and a small container allowance. Short videos may be sampled in full because that is both fast and more reliable.

An estimate is explicitly marked with `Estimated` and `≈`; it is not a guarantee. The tooltip shows a likely range because CRF output depends on scene complexity. Starting real compression immediately stops automatic estimation first, so the real encode never waits for all estimates and the two FFmpeg workloads do not run together. While compression is active, a queued file waiting for an estimate has a compact priority button. It pauses the current FFmpeg encode without discarding progress, runs prioritized estimates in click order, then resumes that same encode. A prioritized request can be cancelled before or during its estimate. After compression, the factual before/after size replaces the forecast.

Each queued video shows its source resolution, frame rate, and bitrate. Changing the preset or any Quality control invalidates queued forecasts and schedules a debounced recalculation. Results are cached locally using absolute path, file size, modification time, preset, frame rate, quality, bitrate, resolution option, and algorithm version. The cache is capped at 300 recent entries. Temporary sample files are removed after success, failure, cancellation, and agent shutdown.

### Presets

- **Quality:** original dimensions, copied audio when compatible, controlled AAC 96k fallback. Manual controls (only on this preset): a frame-rate slider (24–120 fps, never above the source), a **quality (CRF)** slider (14–34, lower is better/larger), an optional **target bitrate** (kbps) that overrides CRF when set, and a **keep original resolution** checkbox (on by default; off reveals a field to type the target longest side in pixels, default 1080p, aspect ratio preserved, never upscaled). Balanced and Ultra Small keep their own fixed caps regardless of these controls.
- **Balanced** (default): H.264 CRF 26, longest side up to 720 px, at most 24 FPS, AAC 96k.
- **Ultra Small:** H.264 CRF 30, longest side up to 550 px, at most 20 FPS, mono AAC 48k.

Scaling preserves aspect ratio for horizontal and vertical video. FPS is capped but never increased. Every preset produces an MP4 with fast-start metadata.

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

Every `/api/*` route requires a random per-process 256-bit token. The token is issued only through the `/pair` redirect (production origin) or `/local` (development), which place it in the page URL fragment; the unauthenticated `/health` route exists solely so the packaged launcher can detect readiness. CORS permits only the production page and fixed local development origin. Request bodies are structurally validated, preset parameters are defined only in the agent, and every external process uses argument arrays with `shell: false`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Unauthenticated readiness probe used by the launcher |
| GET | `/pair`, `/local` | Redirect to the site with a fresh session token |
| GET | `/api/health`, `/api/queue`, `/api/diagnostics` | Obtain current state and diagnostics |
| GET | `/api/events` | Live SSE queue snapshots |
| POST | `/api/files/select`, `/api/files/confirm` | Native selection and explicit warning confirmation |
| POST | `/api/settings`, `/api/output/select` | Preset/output settings and native folder selection |
| POST | `/api/queue/start` | Start or continue sequential work |
| POST, DELETE | `/api/jobs/:id/estimate-priority` | Queue or cancel an immediate size estimate during compression |
| POST | `/api/jobs/:id/cancel`, `/retry`, `/reveal` | Manage one job |
| DELETE | `/api/jobs/:id`, `/api/jobs/completed` | Remove queued or clear finished jobs |
| POST | `/api/output/reveal` | Open an available output folder |

## Troubleshooting

- **Agent unavailable:** keep the `npm start` terminal open and reload the page.
- **Missing FFmpeg/FFprobe:** install with `brew install ffmpeg`, then restart.
- **Permission denied:** allow Terminal/Node access in macOS Privacy & Security and choose a writable folder.
- **Disk warning:** free space on the output volume. CRF output size cannot be predicted exactly.
- **Unsupported/damaged video:** the failed card remains retryable and the next queued file still runs.
- Technical diagnostics remain in the local terminal log; video contents are never logged.

## Current limitations

- macOS Apple Silicon only. A packaged `.app` and drag-to-Applications DMG exist (`npm run package:dmg`), but the test build is ad-hoc signed, not notarized, so it needs the one-time quarantine step above. No automatic updates yet.
- One local agent and one FFmpeg encoding process at a time.
- Retry restarts a file from the beginning; there is no partial resume.
- State is local JSON, not a multi-user database. Source files moved after selection will fail clearly.
- “Show output folder” opens one relevant folder; jobs saved beside originals may span several folders, while each card can reveal its exact result.
