# Wishly — test guide

## How to install

> **Upgrading from "Local Video Compressor Agent"?** The app was renamed, so dragging Wishly Agent into Applications will **not** replace the old app. First quit the old agent (menu bar film icon → **Quit**), then delete **Local Video Compressor Agent.app** from Applications, and only then install Wishly Agent. Your local queue and settings are migrated automatically on the first launch.

1. Download the uniquely versioned DMG (`Wishly-Agent-v…-macOS-arm64.dmg`), open it, and drag **Wishly Agent** to Applications. Choose **Replace** if macOS asks.
2. Open the **Terminal** app (Applications → Utilities → Terminal).
3. Paste this command and press Return:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Wishly Agent.app"
   ```

4. Open **Wishly Agent** from the Applications folder. Its menu shows the exact product version and build number.

This command is required after each newly downloaded test build because the app is not yet notarized. It clears the download-quarantine flag for this single app; it does **not** disable macOS security. (macOS does not offer an “Open Anyway” button for this build because it is ad-hoc signed, so the command above is the supported way to launch it.)

## Connect and compress

The Agent has **no Dock icon** — it runs from the menu bar (the film icon at the top-right). On first launch it opens the matching interface bundled inside the installed app and connects automatically. Add videos with the drop zone or native picker, select their checkboxes, then choose **Compress selected**. The selected output setting is respected for both natively selected and dropped videos; Wishly no longer forces dropped results into `~/Movies/Wishly`. Videos never leave your computer.

To add images, enable **Embed images into video** below the compression settings. You can choose only an opening image, only a final image, or both. The opening image lasts exactly one output frame. For a final image, select a random range or enter `HH:MM:SS`, then choose fill/crop, fit, or stretch. A random duration is chosen separately for each selected video and is shown in that video's card after the batch starts. PNG, JPEG, and WebP are supported.

The original video is never overwritten. Embedded results use names such as `video_embedded_compressed.mp4`; an existing result receives a numeric suffix. If an image is moved, deleted, or damaged in the Agent's local storage, the affected card shows an error while the remaining queue continues.

## Convert images from Finder

On the first launch, choose **Open Settings** in Wishly's Finder conversion
prompt and enable **Wishly Finder** once. You can reopen the same macOS screen
later from the menu-bar icon → **Enable Finder Conversion…**.

In Finder, right-click one or more still images and choose **Convert to** →
**PNG**, **JPEG**, or **WebP**. Wishly launches silently if necessary and places
each result beside its original. Existing files are preserved: for example, an
occupied `photo.jpg` produces `photo_2.jpg`. A source already in the selected
format is skipped, and animated images are not flattened silently.

Successful conversions need no extra window—the new files appear in Finder. If
one fails, the Wishly menu-bar icon changes to a warning; open its **Finder
conversion failed — Details…** item for the reason.

## Test the Team workspace pilot

Open **Team workspace** only with the account and Google Drive folder assigned by the pilot
moderator. A Wishly team role does not remove sharing that was granted directly in Google
Drive: removing someone from Wishly may still leave their independent Drive access intact.
Do not use production customer files in a pilot fixture.

The first release supports video/image previews, safe transcript previews, archive entry
lists, and isolated landing previews. TXT editing is limited to complete, valid UTF-8 `.txt`
files no larger than 1 MiB; `.srt`, `.vtt`, invalid, truncated, and larger text stays
read-only. A new version is a separate linked file and never silently overwrites the source.
Browser downloads stop at 100 MiB and hand larger files to a compatible Wishly Agent; each
permission-checked transfer range is at most 32 MiB, and Agent intake stops at 100 GiB or the
selected tool's lower limit.

Archive preview shows a manifest and rejects unsafe/password-protected content, more than
50,000 entries, more than 5 GiB expanded total, a single entry over 2 GiB, suspicious
compression, and path traversal. Landing content runs in an isolated preview that blocks
external navigation, forms, popups, top navigation, and network access.

If Wishly reports permission loss, a stale source, an unavailable root, reauthorization,
agent mismatch, or a provider outage, stop and record the displayed error code. Do not retry
with a new filename, reconnect a different account, or edit the Drive object unless the
moderator instructs you. A provider operation may have succeeded while Wishly is reconciling;
starting a replacement can create the duplicate that the safe-recovery path is designed to
avoid. Trash recovery follows the current Google Drive retention/admin policy and cannot be
guaranteed after someone purges the item directly in Drive.

Moderators must use the copy-ready 20-person SC-001, SC-005, and SC-008 scripts in
[`docs/TEAM_WORKSPACE_PILOT_PROTOCOL.md`](docs/TEAM_WORKSPACE_PILOT_PROTOCOL.md). Those
scripts define exactly when timing starts, when to stop, what counts as help, and what must be
recorded; an informal walkthrough is not a scored pilot run.

## Quit and report a problem

Quit the app from its **menu bar icon** → **Quit Wishly Agent** (there is no Dock icon). In the interface open the compact header menu, choose **Copy diagnostics**, and send that text with a short description. The report includes separate web/Agent versions, build IDs, API compatibility and instance start time; it excludes videos and full private paths.
