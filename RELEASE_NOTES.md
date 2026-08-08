# v0.9.4

- Simplify Soty’s public homepage and align Google OAuth branding and privacy surfaces with the released product.
- Keep the not-yet-ready Google Drive workspace out of the production OAuth scope configuration.

# v0.9.3

- Full rebrand to **Soty** across the local macOS app, Windows installer, web application, downloadable artifacts, and app icons.
- Replace the header mark with a clean Soty SVG lockup and make its light/dark appearance cross-fade smoothly without residual transition artifacts.
- Add the Soty honeycomb visual system and align the interface, progress styling, metadata, and install experience with it.

# v0.9.2

- Move the canonical Soty web app to `https://soty.pp.ua` and align the packaged Agent, authentication callbacks, Google Drive workspace flow, and production release checks with the new origin.

# v0.9.1

- Stop the local agent from loading the CPU in the background when nothing is running: cancelling, removing, or restarting a task now actually stops the media work it started, instead of letting hidden ffmpeg passes keep the machine warm until the agent is quit.
- Fix cancelling a task while it is preparing images so it stops immediately and is reported as cancelled rather than failed.
- Fix the queue occasionally refusing to start a new task "as if it were already busy" until the agent was restarted, including after a failed start or a brief media-engine hiccup.

# v0.9.0

- Add Team Workspace for creating teams, inviting up to 50 members, managing roles and independent file/metadata permissions, and transferring ownership safely.
- Connect one shared Google Drive root per team through a fail-closed OAuth flow, with server-held credentials, live ancestry/capability checks, resumable transfers, and recoverable file operations.
- Add a permission-filtered media catalog with canonical classification, GEO/language/offer/tag metadata, combined search and filters, bounded transcript indexing, and durable synchronization.
- Preview video, images, transcripts, archives, and isolated landing packages, then run existing Soty tools and return separate provenance-linked results without overwriting sources.
- Add RLS-protected database authority, scoped transfer grants, append-only audit, privacy-safe analytics, bilingual UI, and old-Agent compatibility gates for the new team routes.

# v0.8.10

- Load external fonts, images, and scripts when rendering landing previews so they match the published page instead of blocking every outside request.
- Add desktop, tablet, and mobile device presets plus a light/dark theme for previews, and a grid overview to scan every landing at a glance.
- Render several landings at once instead of one at a time, with a per-render time limit and de-duplicated extraction for ZIPs that hold multiple landings.
- Remember opened catalogues, remove a folder from the list, flag folders whose source went missing, and stop re-scanning the whole folder on every visit.
- Zoom previews with Ctrl/⌘ + scroll and drag to pan, keep the collapsed sidebar keyboard-safe, and reconnect automatically after the local agent restarts.

# v0.8.9

- Preserve custom zoom, fit mode, and sidebar state while switching landings and after reopening Landing Preview.
- Replace browser-default grey toolbar buttons with theme-aware Soty controls and restore readable warning contrast in dark mode.
- Capture long pages as seamless full-resolution WebP slices instead of silently saving only the 1440 × 900 viewport, including pages that scroll inside a nested container.
- Reject empty or invalid cached screenshots, eagerly settle lazy-loaded content, automatically rebuild previews created by the old capture profile, and retain the previous valid preview if rebuilding fails.

# v0.8.8

- Add a dedicated full-screen Landing Preview tool that recursively finds `index.html`/`index.htm` landing roots, builds a source tree, and supports search, previous/next navigation, keyboard controls, zoom presets, and true full-screen viewing.
- Render private full-page WebP previews in the bundled Chromium Headless Shell, block external traffic, preserve the last successful image when a refresh fails, and reuse unchanged previews through a persistent local cache.
- Support Google Drive for desktop folders through their mounted Finder/Explorer path, including normal on-demand hydration without Google credentials or a Drive API integration.
- Discover one or many landings inside ZIP archives, safely inspect and extract them into managed cache storage, and reject traversal paths, links, archive bombs, encrypted archives, and unsafe desktop filenames.
- Add current/changed/full rebuild controls, cache clearing, cancellation, recent catalogues, source reveal/open actions, localized EN/UA UI, packaging verification, and end-to-end scanner, cache, HTTP, UI, and real-renderer tests.

# v0.8.7

- Split long, punctuation-poor transcripts into short natural segments before translation, preventing oversized model requests and making results easier to read.
- Detect repetitive or truncated translator output and retry it in smaller pieces with anti-repetition decoding instead of preserving generated copy-paste.
- Improve Hindi and Urdu translation by deriving a timestamp-mapped English meaning pass directly from the speech while keeping the original-language transcript visible.
- Preserve slang, profanity, explicit terms, and source detail in the translation prompt instead of softening or summarizing them.

# v0.8.6

- Clean transcripts of decoder artifacts: stray "..." markers, `[BLANK_AUDIO]`/`(music)` annotations, and duplicated phrases at window seams no longer appear in results.
- Improve recognition of quiet or unevenly mixed speech by normalizing audio loudness before decoding, and recover from decoder repetition loops instead of keeping them.
- Opening a transcript's detail view now joins the translation already in progress instead of restarting it, and interrupted translations resume from where they stopped.
- Show translated text progressively as segments finish, with a character-weighted progress bar and a continuous elapsed/ETA shared between the list and the viewer.
- Add a cancel control for a running translation, a retry control on the list row, and keep the translator warm for 30 minutes so pauses between files no longer pay a full model reload.
- Add "Save with translation": packages the creative into a folder named after the source language and character count, next to the original file, together with a transcript-and-translation text file.

# v0.8.5

- Require a signed-in Soty account to use the local tools; the app confirms the account with the server occasionally and keeps working offline for several days between checks.
- Verify the update manifest's signature before offering any download, so the installer a browser is pointed at cannot be redirected by anyone who does not hold the release key.
- Make navigation flow: the header stays in place across pages, tools and settings transition instead of snapping, and a finished compression morphs from its size estimate into the real result.
- Preserve the transcription queue across restarts, showing interrupted work as retryable instead of silently dropping it.
- Replace the developer password for in-development tools with a clear "still in development, open at your own risk" confirmation.
- Add the groundwork for a future Windows build without changing macOS behavior.

# v0.8.4

- Detect and remove previously embedded static opening and ending sections before estimating a replacement, keeping predicted duration and output size accurate.
- Preserve compressor selections while navigating within Soty and remove stale leave-page prompts and redundant interface copy.
- Refine image embedding controls and responsive layouts across the compressor, account, landing, and transcription interfaces.

# v0.8.3

- Update the local Agent's HTTP routing and static-file dependency chain to patched releases after new production advisories were detected.
- Supersede v0.8.2 without changing its compression, image-pool, re-embedding, repeat, or launch behavior.

# v0.8.2

- Keep Soty idle after launch instead of opening a page automatically; open the interface manually when needed.
- Make **Optimal** explicitly use 30 FPS, CRF 26, and a 720p longest side, with the values visible under the preset button.
- Add scrollable opening and ending image pools, choosing images randomly without repeats until every image in the pool has been used.
- Add **Replace existing** to remove static opening and ending runs before embedding new images and compressing the video.
- Let completed videos run again from their original source with current settings through **Repeat** or **Compress selected**.

# v0.8.1

- Make Finder image conversion reliably use the files selected when the submenu opens, so PNG, JPEG, and WebP actions work even after Finder clears its transient selection.
- Keep the stable and development Finder bridges isolated when both Soty builds are installed, and add privacy-safe native diagnostics for failed handoffs.

# v0.8.0

- Convert one or many selected still images directly from Finder through a native **Convert to** submenu.
- Export PNG, JPEG, or WebP beside each original with collision-safe names; HEIC/HEIF remains available as an input when macOS can decode it, but is not offered as an output.
- Keep conversion private and unobtrusive: Soty queues the work in the local Agent without opening the browser UI and reports completion through macOS.
- Ship the Finder action inside both production and development app bundles, with localized English and Ukrainian labels and a reusable media-action queue for future video workflows.

# v0.7.4

- Automatically translate every completed transcript in the background using the Soty interface language as the default target.
- Show compact per-file translation status and real segment progress directly in the transcription queue.
- Let users change the translation language from a completed file row, cancelling stale work and restarting progress safely.
- Reuse model-versioned translations from the local cache, join repeated in-flight requests, and avoid duplicate inference across identical queued transcripts.

# v0.7.3

- Add a localized **Copy all** action below the transcription queue that copies every completed non-empty transcript in visible order with numbered headings.
- Make **Show in Finder** reveal the original audio or video and stop creating a neighboring plain-text transcript file.
- Use computer-neutral privacy and local-processing copy instead of Mac-specific wording.
- Prevent duplicated words where overlapping transcription windows meet.

# v0.7.2

- Translate transcript segments concurrently and overlap alignment with translation, roughly a 3× speedup on Apple Silicon; keep the model resident so a mid-job pause no longer forces a costly reload.
- Replace the indeterminate translation spinner with a real progress bar that shows the completed percentage and an estimated time remaining.
- Keep karaoke word highlighting from clearing a text selection the user made, and pause the highlight only while a drag is in progress so the selection survives.
- Center the spoken karaoke word reliably in the middle of the viewport as playback advances, measured against the scroll container so it no longer drifts.
- Make the light/dark theme reveal animation portable across browsers by driving the circular wipe from CSS instead of a Chromium-only Web Animations path.

# v0.7.1

- Fix the bilingual transcript viewer's mirrored scroll so the translation column reaches the very top and bottom instead of stopping short, and never overshoots past the last segment.
- Add a live translation progress bar and elapsed-time counter so a running on-device translation shows that it is working and how long it is taking.
- Make the karaoke word highlight clearly readable — a brighter fill and stronger underline, with a dedicated stronger treatment in dark theme.
- Follow the karaoke word smoothly, keeping the spoken word centered in the visible area line-by-line instead of only recentering per segment.
- Report full confidence for a selection whose text is identical on both sides (for example numbers like "25"), instead of the aligner's noisy estimate.

# v0.7.0

- Turn the completed-transcript view into a fully local bilingual split-screen viewer with on-device TranslateGemma translation, race-safe language switching and cache reuse, independent RTL direction, mirrored source↔target selection, measured green→yellow alignment confidence, accessible Copy controls, and reduced-motion support.
- Add one-confirmation, byte-weighted installation of Whisper large-v3, pinned llama.cpp/TranslateGemma, and Multilingual E5. Downloads resume verified `.part` files across CDN disconnects, validate exact size and SHA-256, install atomically, support cancel/retry, and never make a failed translator change a successful transcription into a failure.
- Preserve full Whisper word timestamps in a private structured sidecar while leaving the neighboring plain `.txt` unchanged. Fix karaoke lag/catch-up jumps by keeping timestamp decoding enabled, retaining true chunk offsets during overlap deduplication, and scheduling video highlights from presented-frame media time.
- Add an expandable local media player with custom controls and source-word seeking. Browser-safe originals stream through a token-gated HTTP Range endpoint; unsupported media is converted locally to a cached H.264/AAC MP4 preview without exposing file paths.
- Add a long-lived, authenticated Unix-socket translation worker, a local Multilingual E5 phrase aligner, model/version-aware caches, stale-request cancellation, dedicated document/translation/media APIs, packaging notices, and deterministic plus opt-in real-model smoke coverage.

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
- Open Landing Optimizer to every Soty user without the developer-pass gate.

# v0.5.5

- Redesign image embedding controls with compact square previews, responsive settings, inline validation transitions and accessible image actions.
- Add metadata removal for every compressor output, enabled by default and configurable per queued job.
- Improve compression settings alignment and remove redundant local-processing copy from the editor.

# v0.5.4

- Improve the compressor settings layout and native select styling.
- Mark protected tools as in development without showing a misleading Agent readiness status.

# v0.4.0-test.1

The product is now **Soty**, and the macOS menu bar app is **Soty Agent** (Agent API v5).

- Full rebrand from Local Video Compressor to Soty / Soty Agent, including a new app icon and a new DMG appearance.
- New purple design system and motion system in the web UI.
- New hosted origin: <https://soty-app.pages.dev>.
- Local queue, settings, estimate cache and managed images are migrated automatically from the old `~/Library/Application Support/Local Video Compressor` directory on the first launch of Soty Agent.
- Uploaded (dropped) outputs are now saved to `~/Movies/Soty`.

## Updating the test build

Because the app bundle was renamed, dragging Soty Agent into Applications does **not** replace the old app. Quit **Local Video Compressor Agent** from its menu bar icon, delete it from Applications, then install **Soty Agent** from the new DMG. Your local data is migrated automatically.

This remains an ad-hoc-signed, non-notarized Apple Silicon test build. After copying it to Applications, run:

```bash
xattr -dr com.apple.quarantine "/Applications/Soty Agent.app"
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
