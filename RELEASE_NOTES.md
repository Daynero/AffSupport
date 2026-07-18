# v0.2.0-test.1

This release fixes the recurring state where the website reports that the Agent needs an update even after the app was replaced.

- Every release now has an immutable product version, numeric macOS build number, build ID, versioned tag, and versioned artifact URL.
- Web compatibility uses an explicit Agent API range. An old Agent and an old cached webpage are handled as different cases, so the UI never recommends a downgrade.
- The Agent reports its version, build, API, source revision, instance identity, and start time in diagnostics instead of the ambiguous `0.1.0-test` fallback.
- The launcher validates the exact build answering on port `43120`; it no longer silently adopts an arbitrary older process.
- The launcher opens the interface bundled with its Agent, keeping UI and runtime changes atomic. The hosted page offers this matching local UI as a fallback when an update is required.
- After this version, replacing the `.app` while it is running triggers a safe handoff to the installed build. Active compression can finish before restart.
- Web deployment is blocked until the exact versioned Agent asset has been published, and release scripts refuse to overwrite an existing build artifact.

## One-time migration from v0.1.0-test

The legacy launcher cannot detect that its files were replaced. Quit **Local Video Compressor Agent** from its menu bar icon before copying this version to Applications. If no icon is visible, use Activity Monitor to quit `LocalVideoCompressor`. Then replace the app, clear quarantine for this downloaded build, and launch it again.

This remains an ad-hoc-signed, non-notarized Apple Silicon test build. After copying it to Applications, run:

```bash
xattr -dr com.apple.quarantine "/Applications/Local Video Compressor Agent.app"
```
