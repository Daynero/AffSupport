# Windows port — status and first-build guide

This document tracks the Windows x64 port of Wishly Agent: what is already
portable in the codebase, what can only be finished on a real Windows machine,
and the step-by-step packaging pipeline.

## What is already in place (works from this repo today)

- **Platform layer** — `apps/agent/src/platform/platform.ts` isolates every
  OS-specific mechanism: `%APPDATA%` support root, `.exe` executable names,
  `explorer.exe` reveal/open, bsdtar-based tar.gz/zip archive handling
  (`tar.exe` ships with Windows 10 1803+), pause/resume gated off on win32
  (no SIGSTOP), and uniform `sanitizeFileName`.
- **Native file pickers** — `apps/agent/src/files/picker.ts` has a win32
  branch using PowerShell WinForms dialogs (`OpenFileDialog` with
  multi-select + video/audio filters, `FolderBrowserDialog` for folders),
  spawned as `powershell.exe -NoProfile -NonInteractive -STA -Command …`.
  `capabilities().nativeFilePicker` is `true` on win32. Covered by unit tests
  with a stubbed spawn; the dialogs themselves still need a live check
  (see below).
- **Local translation (llama.cpp over loopback TCP)** — the runtime descriptor
  in `apps/agent/src/translation/tools.ts` is a per-platform table
  (`darwin-arm64`, `win32-x64`). The Windows entry points at the official
  `llama-b10092-bin-win-cpu-x64.zip` release asset (flat zip, extracted via
  the platform zip path) but its **sha256 is intentionally `null`** until
  pinned — the downloader refuses to fetch it (see "Pinning the llama.cpp
  checksum").
- **Multiplatform release manifest** — `ReleasePlatform` includes
  `'windows-x64'`, `stable.json` has an `artifacts` map, and
  `scripts/sign-release-manifest.mjs` accepts `--platform windows-x64`.
  `packages/shared/src/release.ts` exports `RELEASE_ARTIFACT_NAME_WINDOWS`
  and `RELEASE_DOWNLOAD_URL_WINDOWS`. The macOS DMG remains the primary,
  release-gating artifact.
- **Staging** — `scripts/stage-windows-runtime.mjs` builds the installer
  payload mirroring the mac `Contents/Resources` layout (the agent's relative
  `../../../runtime` lookups work unchanged). It shares the lockfile-exact
  dependency staging with the mac pipeline via `scripts/lib/agent-staging.mjs`.
- **Installer template** — `packaging/windows-installer.iss` (Inno Setup):
  installs to `{autopf}\Wishly`, HKCU Run-key autostart of the tray host,
  post-install launch, uninstall stops the host, version/AppId rendered by
  `scripts/render-launcher.mjs`.

## What requires a Windows machine

1. **Pin the llama.cpp Windows sha256** (and exact size) — see below.
2. **Live-test the PowerShell pickers** — the unit tests only verify spawn
   arguments and output parsing; PowerShell does not run on macOS. Verify:
   multi-select, unicode paths, Cancel returning no output/exit 0, and that
   the dialog appears in the foreground.
3. **Tray host** — build/publish `WishlyAgentHost` (`packaging/windows/`,
   `dotnet publish`), verify it supervises `runtime\node.exe agent\dist\…`
   and stops it on exit.
4. **Compile + sign the installer** (Inno Setup `iscc`, Authenticode
   `signtool`).
5. **Full end-to-end pass** — install, pair with the hosted page, compress,
   transcribe, translate (after the checksum pin), uninstall cleanly.
6. **Verify the Windows zip layout assumption** — the descriptor assumes the
   official Windows zip is flat (`llama-server.exe` + DLLs at the archive
   root). If b10092's zip has a top-level directory instead, set
   `extractedDirectory` in `TRANSLATION_RUNTIME_DESCRIPTORS['win32-x64']`
   accordingly.

## Binaries to obtain (all x64, static/portable)

| Input                                                                  | Env var (staging)                                      | Notes                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Portable Node.js `node.exe`                                            | `NODE_BINARY_WIN`                                      | From the official nodejs.org "Windows Binary (.zip)"; same major version as the mac package. |
| Static FFmpeg `ffmpeg.exe`                                             | `FFMPEG_BINARY_WIN`                                    | Fully static build (e.g. gyan.dev / BtbN "static"); no external DLLs.                        |
| Static FFprobe `ffprobe.exe`                                           | `FFPROBE_BINARY_WIN`                                   | Must come from the same build as ffmpeg.                                                     |
| whisper.cpp `whisper-cli.exe`                                          | `WHISPER_BINARY_WIN`                                   | Static/portable win-x64 build of the pinned whisper.cpp version.                             |
| Silero VAD model                                                       | `WHISPER_VAD_MODEL`                                    | `ggml-silero-v5.1.2.bin` (same file the mac package uses).                                   |
| Whisper large-v3 model (optional)                                      | `WHISPER_MODEL`                                        | Omit to keep the installer small; downloaded on first use.                                   |
| FFmpeg/x264 source archives (optional but required for GPL compliance) | `FFMPEG_SOURCE_ARCHIVE_WIN`, `X264_SOURCE_ARCHIVE_WIN` | Must match the exact ffmpeg build being bundled.                                             |

**THIRD_PARTY_NOTICES.md reminder:** the Windows binaries are different builds
from the mac ones. Record their exact versions/build provenance (and the
FFmpeg build's source offer) in `THIRD_PARTY_NOTICES.md` before shipping the
first Windows release.

## Pinning the llama.cpp checksum

`TRANSLATION_RUNTIME_DESCRIPTORS['win32-x64']` in
`apps/agent/src/translation/tools.ts` ships with `sha256: null` and
`sizeBytes: 0`. Until both are pinned, the in-app "install translation
runtime" download refuses with _"checksum not pinned for this platform yet"_.
To pin:

1. Download the exact asset on a trusted machine:
   `https://github.com/ggml-org/llama.cpp/releases/download/b10092/llama-b10092-bin-win-cpu-x64.zip`
2. Compute the hash and size:
   - Windows: `certutil -hashfile llama-b10092-bin-win-cpu-x64.zip SHA256`
   - macOS/Linux: `shasum -a 256 …` and `stat -f %z …`
3. Confirm the zip contains `llama-server.exe` (see layout note above), then
   set `sha256` (lowercase hex) and `sizeBytes` in the `win32-x64` descriptor.
4. Update the pinned expectations in `tests/translation-runtime-platforms.test.ts`
   and run the suite.

## First Windows build — step-by-step

On a Windows x64 machine with git, Node.js (repo's version), .NET SDK,
Inno Setup 6 (`iscc` on PATH) and `signtool` (Windows SDK):

1. **Build**
   ```
   git clone … && cd AffSupport
   npm ci
   npm run build
   ```
2. **Stage the runtime payload** (set the env vars from the table above):
   ```
   set NODE_BINARY_WIN=C:\wishly-deps\node.exe
   set FFMPEG_BINARY_WIN=C:\wishly-deps\ffmpeg.exe
   set FFPROBE_BINARY_WIN=C:\wishly-deps\ffprobe.exe
   set WHISPER_BINARY_WIN=C:\wishly-deps\whisper-cli.exe
   set WHISPER_VAD_MODEL=C:\wishly-deps\ggml-silero-v5.1.2.bin
   node scripts\stage-windows-runtime.mjs
   ```
   (Use `--dry-run` anywhere, including macOS, to preview the plan.)
3. **Publish the tray host** (project maintained in `packaging/windows/`):
   ```
   dotnet publish packaging\windows\WishlyAgentHost -c Release -r win-x64 -o release\windows\host
   signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a release\windows\host\WishlyAgentHost.exe
   ```
4. **Render the installer script** (same replacer as the mac launcher):
   ```
   node scripts\render-launcher.mjs packaging\windows-installer.iss release\windows\installer.generated.iss "PRODUCT_VERSION=<ver>" "BUILD_ID=<ver>+<build>"
   ```
   (`node scripts\release-meta.mjs product-version` / `build-id` print the values.)
5. **Compile the installer**:
   ```
   iscc /DStageDir=%CD%\release\windows\stage /DHostDir=%CD%\release\windows\host release\windows\installer.generated.iss
   ```
   Output: `Output\Wishly-Agent-v<ver>-Windows-x64.exe` (matches
   `RELEASE_ARTIFACT_NAME_WINDOWS`).
6. **Sign the installer**:
   ```
   signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a Output\Wishly-Agent-v<ver>-Windows-x64.exe
   ```
7. **Checksum**: `certutil -hashfile Output\Wishly-Agent-v<ver>-Windows-x64.exe SHA256`
8. **Publish**: upload the exe as a release asset on the same immutable
   `v<ver>` tag as the DMG, then add to
   `apps/web/public/.well-known/wishly/stable.json`:
   ```json
   "artifacts": {
     "macos-arm64": { … },
     "windows-x64": {
       "url": "https://github.com/Daynero/AffSupport/releases/download/v<ver>/Wishly-Agent-v<ver>-Windows-x64.exe",
       "sha256": null
     }
   }
   ```
9. **Sign the manifest** (records the sha256 and re-signs in one step; run on
   the release machine that holds the private key):
   ```
   node scripts/sign-release-manifest.mjs --dmg <path to installer.exe> --platform windows-x64
   ```
10. Deploy the web app as usual; `scripts/verify-release.mjs` still gates on
    the macOS artifact and additionally checks that every listed artifact has
    an https URL and a complete sha256.
