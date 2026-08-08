# Soty Host (Windows)

C#/.NET 8 WinForms tray application mirroring the macOS menu-bar launcher
(`packaging/Launcher.swift`). It owns the single-instance lock, spawns the bundled
Node agent with the packaged environment, restarts it after transient failures,
monitors installed updates, and exposes Open Soty / Quit from the notification area.

## Expected install layout

The host resolves everything relative to its own executable directory (the analogue of
the macOS bundle's `Contents/Resources`). An installer must produce:

```
<installDir>/
  WishlyAgentHost.exe          # this project (plus its .NET files unless single-file)
  release.json                 # scripts/release-meta.mjs --json output
  runtime/
    node.exe                   # portable win-x64 Node.js
    bin/
      ffmpeg.exe               # approved static win-x64 builds
      ffprobe.exe
      whisper-cli.exe
    models/
      ggml-silero-v5.1.2.bin   # VAD model (required)
      ggml-large-v3.bin        # optional; downloaded on first use when absent
  agent/
    dist/index.js              # apps/agent build (entry point)
    package.json
    node_modules/              # production deps, staged by scripts/stage-agent-runtime.mjs
    production-dependencies.json
    browser-runtime.json       # exact bundled preview-browser executable path
    browser/
      chromium-headless-shell/ # Playwright-pinned local landing renderer + license
  web/
    dist/                      # apps/web build, served by the agent at /local
```

This mirrors `packaging/Launcher.swift` (`Resources/runtime/node`, `runtime/bin/*`,
`agent/dist/index.js`) and `scripts/package-mac.sh` lines 38–65. The host itself only
requires `runtime/node.exe`, `runtime/bin/ffmpeg.exe`, and `runtime/bin/ffprobe.exe` to
exist before spawning (same preflight as the Swift launcher); the agent finds the rest
relative to its own directory.

## Rendering the config

`WishlyAgentHost/HostConfig.template.cs` carries the same `__TOKEN__` placeholders as
`Launcher.swift` and is rendered by the existing `scripts/render-launcher.mjs`
(string replace + unresolved-placeholder check). The rendered `HostConfig.cs` is
gitignored; the build fails with a clear error if it is missing.

From the repository root:

```sh
node scripts/render-launcher.mjs \
  packaging/windows/WishlyAgentHost/HostConfig.template.cs \
  packaging/windows/WishlyAgentHost/HostConfig.cs \
  "AGENT_PORT=43120" \
  "APP_NAME=Soty" \
  "INSTANCE_LOCK_NAME=local-video-compressor-agent.lock" \
  "SUPPORT_DIRECTORY_NAME=Wishly" \
  "PUBLIC_SITE_ORIGIN=$PUBLIC_SITE_ORIGIN" \
  "APP_VERSION=$(node scripts/release-meta.mjs product-version)" \
  "BUILD_NUMBER=$(node scripts/release-meta.mjs build-number)" \
  "BUILD_ID=$(node scripts/release-meta.mjs build-id)" \
  "API_VERSION=$(node scripts/release-meta.mjs api-version)" \
  "RELEASE_CHANNEL=$(node scripts/release-meta.mjs release-channel)" \
  "SOURCE_REVISION=$(git rev-parse HEAD)" \
  "AGENT_ENTITLEMENT_PUBLIC_KEY=$AGENT_ENTITLEMENT_PUBLIC_KEY"
```

The token list is identical to the `render-launcher.mjs` invocation in
`scripts/package-mac.sh`. The renderer escapes `\` and `"` for string literals, which is
valid C# escaping too — keep every placeholder inside a regular `"..."` literal in the
template (never a verbatim `@"..."` string). `AGENT_PORT` and `API_VERSION` render as
bare integers.

## Building

Compiles on any OS thanks to `<EnableWindowsTargeting>true</EnableWindowsTargeting>`
(running it requires Windows). No NuGet dependencies beyond the BCL/WinForms SDK packs.

```sh
# Debug/CI compile check (works on macOS/Linux):
dotnet build packaging/windows/WishlyAgentHost -c Release

# Framework-dependent publish (requires .NET 8 Desktop Runtime on the target machine):
dotnet publish packaging/windows/WishlyAgentHost -c Release -r win-x64 --self-contained false

# Self-contained single file (no runtime prerequisite, ~150 MB):
dotnet publish packaging/windows/WishlyAgentHost -c Release -r win-x64 \
  --self-contained true /p:PublishSingleFile=true
```

## Behavioral differences vs. the macOS launcher

- **Update handoff.** On macOS the launcher polls `release.json` inside its own bundle,
  and relaunches itself (`AGENT_UPDATE_HANDOFF=1`) once the agent is not `busy`. On
  Windows a running `.exe` is locked, so **the installer owns file replacement**: it
  must stop the host, replace files, and start the new host. The `release.json` monitor
  and the `AGENT_UPDATE_HANDOFF` wait-for-lock loop are still ported and act as a safety
  net for payload-only updates (agent/, web/, release.json swapped under a running host)
  and to guarantee a clean stop/start sequence for the installer.
- **Termination.** macOS sends SIGTERM to the Node child; Windows has no SIGTERM for
  windowless processes, so the host uses `Process.Kill(entireProcessTree: true)`. The
  agent additionally watches its parent PID and exits if the host disappears, so the
  host must stay the agent's direct parent (it does).
- **Quit guard.** The tray Quit action probes `/health` and asks for confirmation when
  `busy` is true instead of quitting unconditionally.
- **Installed-location guard.** The macOS "move to /Applications" DMG check has no
  Windows counterpart; the installer controls the location. Not ported.
- **Finder integration.** The Finder Sync extension, the image-conversion service
  provider, and the `/native/media-actions` polling (authenticated with
  `X-Wishly-Native-Token`) are macOS-only. A Windows counterpart would be an Explorer
  shell extension; consciously out of scope for this host. The host still generates
  `AGENT_NATIVE_TOKEN` (two concatenated uppercase UUIDv4 strings from a CSPRNG, same
  shape and entropy as the Swift launcher) because the agent requires it at startup.
- **Sibling termination.** When a stale different-build host holds the lock, macOS asks
  the other bundle instances to terminate; Windows kills sibling `WishlyAgentHost.exe`
  processes started from the same path, then enters the same 12-second handoff loop.

## Not done yet — checklist for the first run on a Windows machine

- [ ] Produce `WishlyAgentHost.ico` from `assets/AppIcon.png`, reference it via
      `<ApplicationIcon>` in the .csproj, and load it for the `NotifyIcon`
      (currently `SystemIcons.Application`).
- [ ] Authenticode signing of `WishlyAgentHost.exe`, `node.exe`, `ffmpeg.exe`,
      `ffprobe.exe`, `whisper-cli.exe` (SmartScreen will flag unsigned binaries).
- [ ] An installer (MSIX/Inno/WiX) that produces the layout above, stops the host
      before upgrading, and starts it afterwards; decide on an autostart Run key.
- [ ] Approved **win-x64** builds of Node, FFmpeg/FFprobe (static), and whisper-cli;
      the macOS `package-mac.sh` portability checks (`otool -L`) need a Windows
      equivalent (`dumpbin /dependents`).
- [ ] A `package-windows` script that renders `HostConfig.cs` from release metadata,
      publishes the host, and runs `scripts/stage-agent-runtime.mjs` into
      `<staging>/agent` (the script itself is platform-neutral).
- [ ] Smoke test on Windows: single-instance lock, agent spawn/readiness, crash restart
      (exit 75), quit-while-busy confirmation, update handoff, and that the agent's
      ppid watchdog exits the Node process when the host is killed from Task Manager.
- [ ] Verify no firewall prompt appears for loopback-only listening (the agent binds
      127.0.0.1; Windows Firewall normally stays silent for loopback).
