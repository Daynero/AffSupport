# Local Video Compressor — test guide

## How to install
1. Download the DMG, open it, and drag **Local Video Compressor Agent** to Applications.
2. Open the **Terminal** app (Applications → Utilities → Terminal).
3. Paste this command and press Return:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"
   ```

4. Open **Local Video Compressor Agent** from the Applications folder.

This one command is required only because this test build is not yet notarized by Apple. It clears the download-quarantine flag for this single app; it does **not** disable macOS security. (macOS does not offer an “Open Anyway” button for this build because it is ad-hoc signed, so the command above is the supported way to launch it.)

## Connect and compress
The Agent has **no Dock icon** — it runs from the menu bar (the film icon at the top-right). On first launch it opens the website and connects automatically. Add videos with the drop zone or native picker, select their checkboxes, then choose **Compress selected**. Results are saved beside each natively selected original unless you choose another folder; dropped copies use the Video Compressor output folder. Videos never leave your computer.

## Quit and report a problem
Quit the app from its **menu bar icon** → **Quit Local Video Compressor Agent** (there is no Dock icon). On the website open the compact header menu, choose **Copy diagnostics**, and send that text with a short description. The report excludes videos and full private paths.
