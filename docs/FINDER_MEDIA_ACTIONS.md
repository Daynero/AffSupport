# Finder media actions

Wishly ships a small Finder Sync extension that adds a native **Convert to**
submenu for selected still images. The output targets are intentionally limited
to PNG, JPEG, and WebP. HEIC/HEIF is accepted as an input when the media engine
can decode it, but is not offered as an output.

## Runtime flow

1. The Finder extension checks only inexpensive file metadata, snapshots the
   selected paths while Finder builds the contextual submenu, and never
   re-queries the transient selection from the click callback. It never encodes
   media inside Finder.
2. The selected format and absolute paths are sent through a private macOS
   Service pasteboard type to the containing Wishly app.
3. The launcher forwards the request to the loopback Agent using a random
   per-process native token. The browser API token cannot call these routes.
4. `MediaActionQueue` serializes conversions. Each executor writes a hidden
   temporary file beside the source, validates it, and publishes it with
   no-overwrite semantics.
5. The launcher polls the accepted jobs. Successful output simply appears next
   to the original; failures are surfaced from the Wishly menu-bar item.

The extension must be enabled once in macOS System Settings. Wishly exposes the
system management screen from its menu and offers it once after the feature is
installed. The isolated development build also uses its own executable name,
Service name, bundle identifiers, port, and Agent lock so it can run beside the
stable app without taking over the stable Finder bridge.

## Naming and safety

- `photo.heic` converted to JPEG becomes `photo.jpg`.
- Existing targets are preserved: the next names are `photo_2.jpg`,
  `photo_3.jpg`, and so on.
- A conversion to the source's existing format is disabled or skipped.
- Animated inputs are rejected instead of silently losing animation.
- JPEG output composites transparency over white.
- A request is limited to 100 absolute paths and is accepted only on macOS.

## Video extension point

The bridge is namespaced under `/native/media-actions`, and the queue uses a
job `kind` rather than exposing encoder details to Finder. A future video
feature can add a `video-transcode` job and `/videos/transcode` endpoint while
reusing authentication, queuing, lifecycle drain, collision-safe publishing,
status polling, and Finder error handling. Video presets and cancellation stay
inside the video executor instead of growing the Finder extension.
