# Native HEVC compatibility plan

Base: `895fa7f7`, owner branch `work/next-release-improvements`. Coordinator owns
the final combined full verification/build/database run; local work provides
focused native, browser/static and producer-to-diagnosis evidence.

## Design

Keep the existing H.264 stream-copy planner unchanged. The team restitch delegate
normalizes HEVC before inspection/planning, retains original HEVC profiles in
discovery, and uses verified normalized profiles for the actual pipeline. Bump
the preparation policy generation so cached codec refusals are re-inspected.

Use the shipped software H.264 encoder, governed run seam and scaled bounds.
Normalize orientation, SAR, CFR and AAC; verify before use. No source overwrite.
Compatible H.264 has no extra encode. Preparation eligibility accepts HEVC for
automatic compatibility rather than caching an unsupported-codec refusal.

The shipped ARM FFmpeg exposes float lut1d/lut3d and tonemap, but no zscale.
A local one-frame proof confirmed lut3d preserves float values above1.0. Use
standard PQ/HLG transfer functions, a portable float colour transform and the
native tone mapper; output SDR BT.709 and clear stale HDR/rotation side data.
Qualify those exact filters with the shipped engine, not only system FFmpeg.

An atomic verified-source cache is bounded and keyed by verified source content
revision plus recipe. Shared work owns an independent input link/copy/controller;
consumers hold separate registrations and their own output directory entries.
Cancel only after the last consumer leaves; join actual child/cleanup completion.
Verify manifests/bytes before reuse, never promote partial work and never reuse
restart leftovers. Reuse existing body/screen caches after normalization.

## Acceptance and diagnostics

Real HEVC fixture plus SDR/10-bit/HDR PQ/HLG/VFR/rotation/audio matrix, output
codec/colour/timing/playability and original hashes. Ten-consumer single flight,
independent cancellation/deletion, source loss/change, failed verification,
restart leftovers, cache corruption, disk cap and H.264 no-encode regression.
All heavy tests use one worker and the shared CPU slot.

Content-free journal stages include operation and shared normalization IDs,
closed mode/reason, cache and cancellation. Existing failure codes remain closed;
stage-specific reasons explain conversion/verification/source changes. Map journal
codes and expose bounded SELECT-only diagnosis, including delayed/missing records.
Test the actual producer through the native journal, privacy forwarding, SQL
ingestion and read-only role. Cache completion is not user delivery.

## Primary references

- [ITU-R BT.2100](https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2100-2-201807-S%21%21PDF-E.pdf)
- [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)
- [FFmpeg automatic rotation](https://ffmpeg.org/ffmpeg.html)

These references define transfer/processing behaviour; local native proofs and
fixtures qualify the actual shipped filters. Windows and Intel hardware success
must never be inferred from ARM tests.
