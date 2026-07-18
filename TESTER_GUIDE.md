# Local Video Compressor — test guide

## How to install

1. If `v0.1.0-test` is currently running, use its menu bar film icon → **Quit Local Video Compressor Agent**. This is a one-time migration step; later versions detect replacement and hand off automatically.
2. Download the uniquely versioned DMG, open it, and drag **Local Video Compressor Agent** to Applications. Choose **Replace** if macOS asks.
3. Open the **Terminal** app (Applications → Utilities → Terminal).
4. Paste this command and press Return:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"
   ```

5. Open **Local Video Compressor Agent** from the Applications folder. Its menu shows the exact product version and build number.

This command is required after each newly downloaded test build because the app is not yet notarized. It clears the download-quarantine flag for this single app; it does **not** disable macOS security. (macOS does not offer an “Open Anyway” button for this build because it is ad-hoc signed, so the command above is the supported way to launch it.)

## Connect and compress

The Agent has **no Dock icon** — it runs from the menu bar (the film icon at the top-right). On first launch it opens the matching interface bundled inside the installed app and connects automatically. Add videos with the drop zone or native picker, select their checkboxes, then choose **Compress selected**. Results are saved beside each natively selected original unless you choose another folder; dropped copies use the Video Compressor output folder. Videos never leave your computer.

To add images, enable **Embed images into video** below the compression settings. You can choose only an opening image, only a final image, or both. The opening image lasts exactly one output frame. For a final image, select a random range or enter `HH:MM:SS`, then choose fill/crop, fit, or stretch. A random duration is chosen separately for each selected video and is shown in that video's card after the batch starts. PNG, JPEG, and WebP are supported.

The original video is never overwritten. Embedded results use names such as `video_embedded_compressed.mp4`; an existing result receives a numeric suffix. If an image is moved, deleted, or damaged in the Agent's local storage, the affected card shows an error while the remaining queue continues.

## Quit and report a problem

Quit the app from its **menu bar icon** → **Quit Local Video Compressor Agent** (there is no Dock icon). In the interface open the compact header menu, choose **Copy diagnostics**, and send that text with a short description. The report includes separate web/Agent versions, build IDs, API compatibility and instance start time; it excludes videos and full private paths.
