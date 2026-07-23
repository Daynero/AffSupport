# v0.6.7

- Recover speech skipped at any unstable transcription-window boundary by retrying the combined context with an independent timestamp-aware decoder path.

# v0.6.6

- Improve local transcription accuracy by using overlapping speech windows and recovering phrases that fall on recognition boundaries.

# v0.6.5

- Remove incomplete duplicate lines when Whisper emits a corrected continuation after a mid-word decoder fragment.

# v0.6.4

- Fix incomplete local transcriptions and repeated phrases by preserving Whisper's timestamp tokens during long-form decoding.

# v0.6.3

- Add a local Transcription tool that turns audio and video into plain text fully on-device via whisper.cpp, with automatic language detection across 99 languages, a multi-file queue, and a large text preview with one-tap copy.
- Keep the installer small by fetching the speech model once on first use (with confirmation and progress) into Application Support, verified by checksum; skip silence with VAD and use beam-search decoding for accuracy.
- Gate the Transcription tool behind the developer pass while it is finalized.

# v0.6.2

- Recover safely when the bundled FFmpeg or FFprobe runtime becomes unavailable, preserving completed output validation and queued work across an automatic Agent restart.
- Require stable builds to run from Applications so ejecting a DMG cannot interrupt the media runtime during compression.
- Add a localized in-app update notice with short release summaries and a direct immutable download.
- Restore analytics ingestion for released 0.6.1 clients and retain partially acknowledged offline batches correctly.

# v0.6.1

- Add a persistent light/dark theme switch across the main app, authentication and legal pages, with system-theme detection.
- Add an animated circular theme reveal with accessible reduced-motion and browser fallback behavior.

# v0.6.0

- Redesign Landing Optimizer around compact, expandable landing cards with end-to-end progress and clearer completion summaries.
- Add multi-landing ZIP and folder imports with a sequential optimization queue and independent per-landing actions.
- Add large image previews, including draggable before/after comparisons and single previews when the original image is kept.
- Recompress WebP images when it reduces file size, while always retaining the original when an optimized result would be larger.
- Open Landing Optimizer to every Wishly user without the developer-pass gate.

# v0.5.5

- Redesign image embedding controls with compact square previews, responsive settings, inline validation transitions and accessible image actions.
- Add metadata removal for every compressor output, enabled by default and configurable per queued job.
- Improve compression settings alignment and remove redundant local-processing copy from the editor.

# v0.5.4

- Improve the compressor settings layout and native select styling.
- Mark protected tools as in development without showing a misleading Agent readiness status.

# v0.4.0-test.1

The product is now **Wishly**, and the macOS menu bar app is **Wishly Agent** (Agent API v5).

- Full rebrand from Local Video Compressor to Wishly / Wishly Agent, including a new app icon and a new DMG appearance.
- New purple design system and motion system in the web UI.
- New hosted origin: <https://wishly-app.pages.dev>.
- Local queue, settings, estimate cache and managed images are migrated automatically from the old `~/Library/Application Support/Local Video Compressor` directory on the first launch of Wishly Agent.
- Uploaded (dropped) outputs are now saved to `~/Movies/Wishly`.

## Updating the test build

Because the app bundle was renamed, dragging Wishly Agent into Applications does **not** replace the old app. Quit **Local Video Compressor Agent** from its menu bar icon, delete it from Applications, then install **Wishly Agent** from the new DMG. Your local data is migrated automatically.

This remains an ad-hoc-signed, non-notarized Apple Silicon test build. After copying it to Applications, run:

```bash
xattr -dr com.apple.quarantine "/Applications/Wishly Agent.app"
```

# v0.3.0-test.2

This patch release fixes the **Embed images into video** switch in the bundled and hosted interfaces. The web client now sends only writable image settings to the Agent; managed opening/final image metadata remains restricted to the dedicated image API. This prevents the `400 Bad Request` response that previously returned the switch to its off state.

It includes the image-embedding pipeline introduced in `v0.3.0-test.1`:

- Add an optional opening image for exactly one output frame, a silent final image of a custom or per-video random duration, or both.
- Adapt PNG, JPG/JPEG and WebP images independently to every output using fill/crop, fit/pad or stretch.
- Build the complete video and stereo-silence timeline in one FFmpeg filter graph and one H.264/AAC MP4 encode; no large uncompressed intermediate file is created.
- Freeze the selected images, encoding controls, fit mode and random duration separately for every queued job.
- Include the static section in sequential size estimates, progress, elapsed time, output naming and final FFprobe validation.
- Show image previews, concrete queued durations, expected total duration, real processing stages and localized diagnostics in English and Ukrainian.
- Store uploaded image bytes under opaque local asset IDs. Browser requests remain structured, and FFmpeg still runs with argument arrays and `shell: false`.

The Agent API remains version 4. The hosted page is compatible with Agent `v0.3.0-test.1` and later; this download includes the corrected bundled interface as `v0.3.0-test.2`.

## Updating the test build

Replace **Local Video Compressor Agent** in Applications with this version. Builds from `v0.2.0-test.1` and later perform a version-aware handoff after active compression finishes. The legacy `v0.1.0-test` build still requires one manual quit from its menu-bar icon before replacement.

This remains an ad-hoc-signed, non-notarized Apple Silicon test build. After copying it to Applications, run:

```bash
xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"
```
