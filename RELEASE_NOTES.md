# v0.1.0-test

Private, non-notarized Apple Silicon test build. Install using the DMG by dragging the app to Applications. Video selection, estimation, queueing and compression happen locally; video data is never uploaded.

This refresh adds cancellable priority size estimates during compression. Use the small arrow beside a queued file's estimate status to pause the current encode, estimate selected files in request order, and then resume compression from the same progress. It also fixes secure re-pairing from the hosted Cloudflare page after the Agent restarts, always opens the hosted UI instead of the loopback copy, and keeps the hosted event connection alive with the required CORS response.

Because this build is ad-hoc signed (not notarized), macOS quarantines it after download and will not launch it directly. After dragging the app to Applications, run once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"
```

This clears only the download-quarantine flag for this app and does not disable macOS security. See `TESTER_GUIDE.md`.

Known limitations: macOS arm64 only; the Agent runs from the menu bar and has no Dock icon; Chrome may request Local Network Access; Safari may block HTTPS-to-HTTP loopback, in which case use **Open local version**; no automatic updates; one agent and one encode at a time.
