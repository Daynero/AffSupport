# Soty — test guide

## How to install

> **Upgrading from "Local Video Compressor Agent"?** The app was renamed, so dragging Soty Agent into Applications will **not** replace the old app. First quit the old agent (menu bar film icon → **Quit**), then delete **Local Video Compressor Agent.app** from Applications, and only then install Soty Agent. Your local queue and settings are migrated automatically on the first launch.

1. Download the uniquely versioned DMG (`Soty-Agent-v…-macOS-arm64.dmg`), open it, and drag **Soty Agent** to Applications. Choose **Replace** if macOS asks.
2. Open the **Terminal** app (Applications → Utilities → Terminal).
3. Paste this command and press Return:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Soty Agent.app"
   ```

4. Open **Soty Agent** from the Applications folder. Its menu shows the exact product version and build number.

This command is required after each newly downloaded test build because the app is not yet notarized. It clears the download-quarantine flag for this single app; it does **not** disable macOS security. (macOS does not offer an “Open Anyway” button for this build because it is ad-hoc signed, so the command above is the supported way to launch it.)

## Connect and compress

The Agent has **no Dock icon** — it runs from the menu bar (the film icon at the top-right). On first launch it opens the matching interface bundled inside the installed app and connects automatically. Add videos with the drop zone or native picker, select their checkboxes, then choose **Compress selected**. The selected output setting is respected for both natively selected and dropped videos; Soty no longer forces dropped results into `~/Movies/Soty`. Videos never leave your computer.

To add images, enable **Embed images into video** below the compression settings. You can choose only an opening image, only a final image, or both. The opening image lasts exactly one output frame. For a final image, select a random range or enter `HH:MM:SS`, then choose fill/crop, fit, or stretch. A random duration is chosen separately for each selected video and is shown in that video's card after the batch starts. PNG, JPEG, and WebP are supported.

The original video is never overwritten. Embedded results use names such as `video_embedded_compressed.mp4`; an existing result receives a numeric suffix. If an image is moved, deleted, or damaged in the Agent's local storage, the affected card shows an error while the remaining queue continues.

## Keep your 2FA keys where you work

The **Записник 2FA / 2FA Wallet** tool holds the two-factor keys for the accounts you log
into all day, one line each. It is the only tool that needs nothing installed — it works with
the desktop app closed.

1. Press **Додати / Add**. A new line appears in the table itself: give it a name you will
   recognise, paste the key the service showed you, and confirm with the green tick. A whole
   `otpauth://` link works too — Soty takes the key out of it and fills in the name. The
   little arrow beside **Додати** pastes a key straight from your clipboard.
2. Every line already shows its current code — you do not press anything to see one. Click the
   digits and they are on your clipboard; switch to the login page and paste. The bar above
   the column drains as the thirty seconds run out, and all the codes change together when it
   empties.
3. Leave the page alone for a couple of minutes and the codes blur, so a screen left on a desk
   is not a list of live codes. Move the mouse and they are back. There is nothing to switch
   on or off.
4. The key itself is never shown in the table. The **…** button on the line copies it, or
   shows it when you need to check it against the service — and it is hidden again as soon as
   you leave the page.
5. The **…** button also renames a line, editing it in place. Leave the key field empty to
   change only the name.
6. The search box at the top finds a line by name **or** by the key — paste a fragment of a
   key to find out which account it belongs to. **⌘K** jumps to it from anywhere on the page.
7. The **Швидкий код** field above the table is for a key that is _not_ in the wallet: paste
   it and its code appears at once, in the same column as all the others. Click the digits to
   copy. Nothing is saved. Useful when somebody sends you a key or you are half-way through
   setting an account up.
8. Tick several lines to delete them together. Deleting asks first, and is permanent.

Your keys are stored privately: only your own account can read them, they are encrypted in
Soty's vault rather than sitting in a table, and a deleted key is gone — Soty cannot bring it
back, and you would have to set two-factor up again with the service.

If every code you produce is rejected, check the computer's clock. Soty warns you when it is
far enough out to break codes, because a wrong clock looks exactly like a wrong key.

## Change the photo screens on a video

The **Зашивка відео / Video Stitcher** tool swaps the photo screens at the start and end of a
video without compressing it again. The video itself is copied through untouched, so it can
be re-stitched as many times as you like without losing quality.

1. Open the tool and press **Вибрати відео**. Soty asks the system for the file, so the result
   can go next to the original.
2. Pick a photo for the start, the end, or both. They come from the same library the
   compressor uses.
3. Read the one line above the button: it says what Soty found in the video and how long the
   result will be. If a boundary looks wrong you can move it — but you do not have to.
4. Press **Зашити**. It takes seconds, not minutes.

**Прибрати зашивку** strips the screens back off and gives you the clean video.

Worth reporting:

- a video Soty declines — it will say why (not H.264, not AAC, a variable frame rate). That is
  expected for some files, but tell us which ones you hit.
- a result whose length is not what the line promised, or that will not play somewhere it
  should. Soty checks every file before handing it over, so this should never reach you.
- anything that takes longer than about five seconds after you press the button.

## Convert images from Finder

On the first launch, choose **Open Settings** in Soty's Finder conversion
prompt and enable **Soty Finder** once. You can reopen the same macOS screen
later from the menu-bar icon → **Enable Finder Conversion…**.

In Finder, right-click one or more still images and choose **Convert to** →
**PNG**, **JPEG**, or **WebP**. Soty launches silently if necessary and places
each result beside its original. Existing files are preserved: for example, an
occupied `photo.jpg` produces `photo_2.jpg`. A source already in the selected
format is skipped, and animated images are not flattened silently.

Successful conversions need no extra window—the new files appear in Finder. If
one fails, the Soty menu-bar icon changes to a warning; open its **Finder
conversion failed — Details…** item for the reason.

## Test the Team workspace pilot

Open **Team workspace** only with the account and Google Drive folder assigned by the pilot
moderator. A Soty team role does not remove sharing that was granted directly in Google
Drive: removing someone from Soty may still leave their independent Drive access intact.
Do not use production customer files in a pilot fixture.

The first release supports video/image previews, safe transcript previews, archive entry
lists, and isolated landing previews. TXT editing is limited to complete, valid UTF-8 `.txt`
files no larger than 1 MiB; `.srt`, `.vtt`, invalid, truncated, and larger text stays
read-only. A new version is a separate linked file and never silently overwrites the source.
Browser downloads stop at 100 MiB and hand larger files to a compatible Soty Agent; each
permission-checked transfer range is at most 32 MiB, and Agent intake stops at 100 GiB or the
selected tool's lower limit.

Archive preview shows a manifest and rejects unsafe/password-protected content, more than
50,000 entries, more than 5 GiB expanded total, a single entry over 2 GiB, suspicious
compression, and path traversal. Landing content runs in an isolated preview that blocks
external navigation, forms, popups, top navigation, and network access.

If Soty reports permission loss, a stale source, an unavailable root, reauthorization,
agent mismatch, or a provider outage, stop and record the displayed error code. Do not retry
with a new filename, reconnect a different account, or edit the Drive object unless the
moderator instructs you. A provider operation may have succeeded while Soty is reconciling;
starting a replacement can create the duplicate that the safe-recovery path is designed to
avoid. Trash recovery follows the current Google Drive retention/admin policy and cannot be
guaranteed after someone purges the item directly in Drive.

Processing a folder covers everything inside it, subfolders included: it transcribes each
video that has no transcript yet and refreshes every landing preview it finds, and each
transcript is written beside its own video rather than at the top. A running batch can be
paused — nothing new starts, and the file already in flight is suspended too when the local
app is new enough to hold it; the panel says which of the two you are getting. "Stop after
current" drops the rest of the queue and lets the current file finish.

A space can also carry one answer for re-stitching. In **Space settings → Re-stitching**, a
manager picks the operation, the photos and the hold length once; every member then gets
**Download re-stitched** beside **Download the original** on any video. **Prepare material**
looks at every video in the space once — this takes minutes for a large space and can be
stopped without losing what it already found — and afterwards a re-stitched download is a few
seconds rather than half a minute. It also creates the space's `Soty` folder on the connected
drive; you may rename or move that folder freely, Soty finds it either way. If you press the
button before anyone has saved the settings, the toast offers to open them and then continues
the download you asked for.

Moderators must use the copy-ready 20-person SC-001, SC-005, and SC-008 scripts in
[`docs/TEAM_WORKSPACE_PILOT_PROTOCOL.md`](docs/TEAM_WORKSPACE_PILOT_PROTOCOL.md). Those
scripts define exactly when timing starts, when to stop, what counts as help, and what must be
recorded; an informal walkthrough is not a scored pilot run.

## Quit and report a problem

Quit the app from its **menu bar icon** → **Quit Soty Agent** (there is no Dock icon). In the interface open the compact header menu, choose **Copy diagnostics**, and send that text with a short description. The report includes separate web/Agent versions, build IDs, API compatibility and instance start time; it excludes videos and full private paths.
