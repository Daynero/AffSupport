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
