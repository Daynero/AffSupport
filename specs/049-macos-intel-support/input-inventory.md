# Implementation inventory — 2026-11-06

Status: pinned Intel engines built and statically inspected on 2026-11-07; physical Intel execution remains unproven.

| Input            | Repository reference                                                                  | Intel prerequisite                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | Portable `NODE_BINARY`, shared JS runtime                                             | Exact approved x64 Node version/digest, official source/license; inspect minimum deployment and system dylibs before staging                          |
| FFmpeg / FFprobe | THIRD_PARTY_NOTICES.md: FFmpeg 7.1.1, x264 `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee` | Build portable x86_64 counterparts with corresponding source archives, no Homebrew runtime links; record final input digests/build flags/CPU baseline |
| Whisper          | THIRD_PARTY_NOTICES.md: whisper.cpp 1.9.1 MIT                                         | Portable Intel build with conservative CPU baseline; no build-host native tuning; verify VAD, fast/accurate models and cancellation on physical Intel |
| Chromium         | lockfile: Playwright 1.62.1, headless shell revision 1234                             | Exact revision for Intel, supplied as `SOTY_CHROMIUM_SOURCE_ROOT` when cross-building; inspect all helpers/dylibs and deployment floor                |
| Models           | Existing ggml Silero VAD and downloaded Whisper models                                | Architecture neutral data, retain existing digest/size checks and caches                                                                              |
| Swift / Finder   | Existing macOS 13 launcher + extension                                                | Compile x86_64 target with macOS SDK; inspect final payload recursively                                                                               |

Pinned Intel inputs have been staged; no physical Intel machine has been established in this session. macOS 13 compatibility remains a release acceptance claim to prove, including Chromium's actual minimum OS; the package inspector must reject any payload exceeding it. CPU instruction compatibility cannot be established by Mach-O slice alone.

## Download callers

`apps/web/src/release-manifest.ts` is the resolver. Callers: `App.tsx` Onboarding (four link locations), `components/LocalAppDialog.tsx`, `components/ReleaseUpdateNotice.tsx`, `pages/AccountPage.tsx`. The explicit ARM helper must remain ARM-specific; Intel must never inherit a predicted URL as availability.

## Packaging / proof consumers

Mac production/dev/beta and DMG shell scripts, Finder compilation; `agent-staging.mjs`, `stage-agent-runtime.mjs`, `verify-staged-dependencies.mjs`; release/dev metadata; `beta-package-provenance.mjs`, `verify-beta-runtime.mjs`, `verify-beta-package.sh`, `verify-beta-promotion.mjs`; full runner `intent`, `step-adapter`, `bindings`, `evidence`, package/manifest adapters; release signing, provider and publication verifiers; mini `web-only-runtime`, `release-web-only`, `release-web-meta`. Existing ARM output locations are compatibility interfaces; Intel lives in their `x64` subdirectories. No global cache or main-worktree build output is reused as mutable staging.

## Diagnostic seams

Native identity: `platform/platform.ts` → `/health` and `/api/health` in `server/app.ts` → `api/client.ts` health parsing → `AgentContext.tsx` → analytics context/service. Typed events and sanitization: `analytics/events.ts`, `guard-contract.ts`, `service.ts`; server RPC `ingest_analytics_events` and `analytics_properties_are_safe_v2` via forward migration. CLI: `scripts/analytics/queries.ts`, `investigate.ts`, `coverage-registry.ts`, `code-map.ts`, `cli.ts`, `schema.ts`. Keep browser architecture unchanged. Closed native keys require both client and SQL guards plus pipeline regressions.

Preboot seam: `packaging/Launcher.swift`; startup has no remote observer before Node/link. Support diagnostics route exists in `server/app.ts`; bounded launcher-stage evidence is integrated through the diagnostics route and local startup CLI. Missing boot is insufficient evidence of OS rejection.

## Sources inspected

Repository package-lock and THIRD_PARTY_NOTICES are exact local pins. Official upstream references: [Node downloads](https://nodejs.org/en/download/archive/v22), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [Playwright source](https://github.com/microsoft/playwright), [FFmpeg source](https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz). These references establish source locations, not approval or Intel execution evidence.

## First-target runtime staging

`npm run runtime:mac -- --arch=x64 --inputs=/absolute/inputs.json` materializes local inputs at `release/inputs/x64` without requiring a production app or release. The manifest has `schemaVersion: 1`, `architecture: "x64"`, `cpuBaseline: "x86-64"`, and `files` keyed by `node`, `ffmpeg`, `ffprobe`, `whisper`, `vad`, `ffmpegSource`, `x264Source`. Each entry supplies absolute local `path`, exact lowercase `sha256`, token `version`, HTTPS `source` without credentials/query, and SPDX-style `license`. Inputs must be reviewed/pinned by the operator; staging checks completeness/digests and static native compatibility, never claims physical runtime or Apple trust. VAD/model data retain architecture neutrality. No network fetch or app/user auth occurs. Custom inputs and source archives must be supplied explicitly; the pinned Intel build recipe provides the established default set.

Dev/beta use this source automatically when no corresponding production source app exists. Provenance contains only fixed keys, digests/versions/public source/license and CPU baseline, no source machine paths. The packager rechecks staged file digests before copying. Neither target overwrites an existing staged input tree.

## Actual staged inputs — 2026-11-07

Node 22.23.4 (official current Node 22 LTS checksum), FFmpeg/FFprobe 7.1.1 with pinned static x264, CPU Whisper 1.9.1 and VAD 5.1.2 were staged successfully. `packaging/macos/inputs.json` contains upstream pins; `scripts/build-intel-inputs.sh` contains the exact one-worker cross-build recipe. Four runtime Mach-O files passed recursive x86_64, macOS 13 deployment and system-only dylib checks. Chromium revision 1234 was independently inspected: five native files, x86_64, minimum OS 13.0. No execution under translation is counted as hardware acceptance.

```json
{
  "schemaVersion": 1,
  "target": "macos-x64",
  "cpuBaseline": "x86-64-v2",
  "files": [
    {
      "key": "node",
      "sha256": "e55a748c81980fda1399e65b686708960d6bb9b7e8ea5913d85a97c6a19e7a7b",
      "version": "22.23.4",
      "source": "https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-x64.tar.gz",
      "license": "MIT"
    },
    {
      "key": "ffmpeg",
      "sha256": "77869eab4bc8f9c51029541138cc754f9f28e6b1d28b3f7980efeb99d4a21bf4",
      "version": "7.1.1",
      "source": "https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz",
      "license": "GPL-2.0-or-later"
    },
    {
      "key": "ffprobe",
      "sha256": "371a945d8321c68ea96555429489c88117126d0ee5f0e772d06515a67a17cdd2",
      "version": "7.1.1",
      "source": "https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz",
      "license": "GPL-2.0-or-later"
    },
    {
      "key": "whisper",
      "sha256": "6ee6146dd9dac431a951347980848fd2a97b2667e2490b6149c55ad79e3633ef",
      "version": "1.9.1",
      "source": "https://github.com/ggml-org/whisper.cpp.git",
      "license": "MIT"
    },
    {
      "key": "vad",
      "sha256": "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
      "version": "5.1.2",
      "source": "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
      "license": "MIT"
    },
    {
      "key": "ffmpegSource",
      "sha256": "733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1",
      "version": "7.1.1",
      "source": "https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz",
      "license": "GPL-2.0-or-later"
    },
    {
      "key": "x264Source",
      "sha256": "db1e30da244395ba52cf77161bd277c50aaccca8617e6316bc56a5529252333b",
      "version": "0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee",
      "source": "https://github.com/mirror/x264.git",
      "license": "GPL-2.0-or-later"
    }
  ]
}
```
