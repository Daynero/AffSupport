# Phase 0 Research: Windows Release Rollout

**Feature**: `specs/006-windows-release-rollout` | **Date**: 2026-08-19

All unknowns from the plan's Technical Context are resolved here. Findings marked **verified**
were confirmed against the live source during research; findings marked **assumed** carry a
fallback.

---

## R1. Where the Windows artifact is built

**Decision**: GitHub-hosted `windows-2022` runners, driven by a new
`.github/workflows/release-windows.yml`, triggered from the repository.

**Rationale**:

- The repository is **public** (verified: `gh repo view Daynero/AffSupport --json visibility` →
  `PUBLIC`), so GitHub Actions minutes on Windows runners are free. The 2× Windows minute
  multiplier that makes this expensive on private repos does not apply.
- The runner image already ships every tool the pipeline needs, so no installation step is
  required (verified against `actions/runner-images` `Windows2022-Readme.md`):

  | Tool | Preinstalled version | Used for |
  | --- | --- | --- |
  | Inno Setup | 6.7.1 | compiling `packaging/windows-installer.iss` (`iscc`) |
  | .NET SDK | 8.0.x (plus 9/10) | `dotnet publish` of `SotyAgentHost` |
  | Node.js | 22.23.2 | `npm ci`, `npm run build`, all `.mjs` scripts |
  | 7-Zip | 26.02 | unpacking vendored `.7z`/`.zip` inputs |
  | Windows SDK | 10.0.26100.0 | `dumpbin`-equivalent dependency checks (not signing — out of scope) |

- The maintainer owns no Windows machine (confirmed in the spec), so this is the only option that
  satisfies FR-026 without renting a persistent VM.

**Alternatives considered**:

- _Rented cloud Windows VM_ — rejected as the primary build host: it reintroduces a manual,
  stateful machine, which is exactly the failure mode FR-026 forbids. Retained only as the
  one-off venue for the human checks in FR-038.
- _Cross-compiling the installer on macOS_ — rejected: `iscc` and `dotnet publish -r win-x64`
  with WinForms can be *compiled* cross-platform (`EnableWindowsTargeting`), but nothing can
  *verify* the result, and FR-036/FR-037 require real execution.

---

## R2. Sourcing the bundled Windows binaries without a maintainer machine

**Decision**: a committed input manifest (`packaging/windows/inputs.json`) pins every third-party
input by exact URL + sha256 + size; a new `scripts/fetch-windows-inputs.mjs` downloads and
verifies them in CI. Every input is **mirrored into an immutable release of this repository**
(tag `windows-inputs-1`) by a one-shot `mirror-windows-inputs.yml` workflow; the manifest records
both the mirror URL (what the build fetches) and the upstream URL (provenance for
`THIRD_PARTY_NOTICES.md`).

**Rationale**:

- Retention of upstream assets is not uniform, and one source demonstrably prunes:
  - **BtbN/FFmpeg-Builds prunes.** Verified: the repo currently exposes 39 releases total —
    daily `autobuild-YYYY-MM-DD-HH-MM` tags for roughly the last two weeks, then monthly
    stragglers. A tag pinned at release time will be gone within months, breaking FR-029
    (reproducible from a clean checkout of the released commit).
  - **GitHub release assets on ordinary tags are durable** (whisper.cpp, llama.cpp), and
    **nodejs.org/dist is a permanent archive**. These could be fetched directly, but mirroring
    them too collapses the build's external dependencies to one host and one trust decision.
- The GitHub releases API exposes a `digest` field per asset, so checksums can be pinned from
  macOS without ever downloading on Windows. **Verified end to end**: the API digest for
  `llama-b10092-bin-macos-arm64.tar.gz` is
  `sha256:f3ec2351e06322478e3f38f23f5339cd834cca5e3740f334ce2bdc5de95f90e0`, byte-identical to
  the hash already pinned in `apps/agent/src/translation/tools.ts`. The API is therefore a
  trustworthy pinning source for this project's own existing practice.
- Mirroring is performed by a workflow run, not a maintainer upload, satisfying FR-027's "no
  artifact uploaded from a maintainer's machine".

**Alternatives considered**:

- _Fetch straight from upstream every build_ — rejected on the BtbN retention evidence above.
- _Commit binaries to the repo_ — rejected: hundreds of MB in git, and the constitution already
  treats `packages/shared/dist` as the only tolerated committed build output.
- _Build FFmpeg from source in CI_ — initially rejected as a multi-hour job per release, then
  **adopted** once R3 showed no suitable prebuilt binary exists: caching the result on its pinned
  source revisions makes it a one-time cost rather than a per-release one.

---

## R3. Which FFmpeg to bundle — the top risk, now resolved

**Decision**: **compile FFmpeg 7.1.1 + x264 `0480cb05` for win64 in CI**, matching the macOS
build exactly. The initial plan was to bundle a prebuilt static win64 GPL binary from the 7.1.x
line; the availability check below showed none exists any more, and the analysis that followed
made building it ourselves the better option regardless. The full reasoning is under
"Decision taken" below.

**Why the version matters at all**:

- SC-003 requires the same input to produce an equivalent result on both platforms. FFmpeg minor
  versions change x264 defaults, filter behaviour, and container muxing details; a silent version
  skew is the most likely cause of a "works but differs" parity failure.
- **Verified constraint**: BtbN no longer builds the 7.1 line. Its current release carries
  `win64-gpl` assets for master (`N-126217`), `n8.1.2` and `n9.0.1` only. Obtaining 7.1.1 for
  Windows therefore requires an archival source (gyan.dev's `packages/` directory keeps older
  full builds) — availability must be confirmed as the first task of this workstream.
- The compressor's presets are explicit (`apps/agent/src/ffmpeg/presets.ts`), so a version skew
  would show up as measurable output deltas — but avoiding the skew entirely is cheaper than
  measuring and explaining it.

**Availability check performed (T001) — the risk materialised.** Verified against both candidate
hosts on 2026-08-19:

- **BtbN no longer builds the 7.1 line.** A paginated scan of every asset across all 39 retained
  releases returns **zero** `n7.1.*win64-gpl` artifacts; the current release carries only master
  (`N-126217`), `n8.1.2` and `n9.0.1`.
- **gyan.dev does not retain 7.1.x either.** `ffmpeg-7.1-full_build.7z`,
  `ffmpeg-7.1.1-full_build.7z` and both `essentials` variants all return **404**.
- The macOS side is confirmed self-built: the shipped binary reports
  `ffmpeg version 7.1.1 … --enable-gpl --enable-libx264 --disable-shared --enable-static`, built
  from source in a temporary prefix — i.e. the project already builds its own FFmpeg on macOS
  rather than consuming a third-party build.

**Decision taken: build FFmpeg 7.1.1 for win64 ourselves in CI**, from the official
7.1.1 release tarball (`sha256 733984395e0d…`, pinned) and VideoLAN x264 at commit
`0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee` — the exact revision
`THIRD_PARTY_NOTICES.md` already records for the macOS build — using the same
configure flags macOS uses.

**Rationale**: this is the only option that satisfies SC-003 (identical output on
both platforms) rather than merely testing for divergence, and it makes the GPL
obligation trivially correct: the corresponding source we must offer is the
archive we built from, exactly as the macOS package already ships. Bundling a
third-party binary would instead oblige us to reproduce *that builder's* exact
tree and scripts, for a version that does not match macOS anyway.

**Cost, and why it is acceptable**: an MSYS2 static build is slow, so it is
cached on the pinned source revisions (`ffmpeg-win64-<ffmpegSha>-<x264Rev>`).
It compiles once; every later release restores it, keeping SC-011's one-hour
budget intact after the first run. The workflow's timeout is 120 minutes to
allow that first cold build.

**Alternative rejected**: bundling BtbN's `n8.1`/`n9.0` win64-gpl build. Cheap,
but accepts a cross-platform FFmpeg version skew on a product whose whole value
is predictable encoding, and drags in a third-party source-offer obligation.

**GPL compliance**: whichever build is chosen, its matching FFmpeg and x264 **source archives**
must be mirrored alongside it and staged into `licenses/sources/`
(`scripts/stage-windows-runtime.mjs` already accepts `FFMPEG_SOURCE_ARCHIVE_WIN` /
`X264_SOURCE_ARCHIVE_WIN`), and the exact build provenance recorded in
`THIRD_PARTY_NOTICES.md`.

---

## R4. Pinning the llama.cpp Windows runtime (unblocks FR-011)

**Decision**: pin `TRANSLATION_RUNTIME_DESCRIPTORS['win32-x64']` to
`sha256 = c842fa7dc90e32b327c62903f4310ef251a902c90ef5b3a6c01c6b675dce078e`,
`sizeBytes = 18_021_876`.

**Rationale**: **verified** from the GitHub releases API for tag `b10092`, asset
`llama-b10092-bin-win-cpu-x64.zip`. The same API's digest for the macOS asset matches the hash
already committed in the repo, which validates the method. `docs/WINDOWS.md` currently claims
this "must be recorded from the real release asset on a Windows machine" — that is wrong; the
API and a plain `shasum` on macOS both suffice.

**Still to verify in CI (cheap, one assertion)**: the descriptor assumes the Windows zip is flat
(`extractedDirectory: null`, `llama-server.exe` at the archive root). The layout check belongs in
the automated Windows verification, and `extractedDirectory` is adjusted if it proves otherwise.

**Alternatives considered**: pinning a GPU (vulkan/cuda) variant — rejected for the first
release; the CPU build runs everywhere and the descriptor table already allows adding variants
later without touching the install flow.

---

## R5. Whisper and models on Windows

**Decision**: bundle `whisper-cli.exe` from the pinned whisper.cpp release's
`whisper-bin-x64.zip` (CPU build), plus `ggml-silero-v5.1.2.bin`; leave `ggml-large-v3.bin` out
of the installer exactly as the macOS pipeline does, so it downloads on first use.

**Rationale**: whisper.cpp publishes per-tag Windows assets (**verified**: tag `v1.9.2` carries
`whisper-bin-x64.zip`, 8 194 445 bytes, digest
`sha256:49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a`, alongside
BLAS/cuBLAS variants). The plain x64 build is the CPU analogue of the bundled macOS binary.

**Compliance gap found**: `THIRD_PARTY_NOTICES.md` has sections for FFmpeg/x264, Node.js,
Playwright/Chromium, Supabase, Google Sign-In, TranslateGemma, llama.cpp and Multilingual-E5 —
but **no whisper.cpp section at all**, on either platform. Adding it is pre-existing debt that
FR-031 makes due now.

**Resolved (T002) — macOS bundles whisper.cpp `1.9.1`**, recovered from the shipped binary's
embedded version string (`release/Soty.app/Contents/Resources/runtime/bin/whisper-cli`). Like
FFmpeg, it is a **local source build** (its debug paths point at a build tree, and it links the
Metal backend), not an official release asset — which is why no version was recorded anywhere.

### Pinned Windows inputs determined (T002–T004)

All four resolved from macOS, with no Windows machine involved:

| Input | Version | sha256 | Bytes |
| --- | --- | --- | --- |
| Node.js `node-v24.13.0-win-x64.zip` (matches the version the macOS package bundles) | 24.13.0 | `ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88` (nodejs.org `SHASUMS256.txt`) | 36 363 905 |
| whisper.cpp `whisper-bin-x64.zip` (CPU) | v1.9.1 | `7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539` | 7 982 101 |
| Silero VAD `ggml-silero-v5.1.2.bin` — hashed from the **shipped macOS package**, so both platforms provably bundle identical bytes | v5.1.2 | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` | 885 098 |
| llama.cpp `llama-b10092-bin-win-cpu-x64.zip` | b10092 | `c842fa7dc90e32b327c62903f4310ef251a902c90ef5b3a6c01c6b675dce078e` | 18 021 876 |

Only FFmpeg/FFprobe (and their GPL source archives) remain unpinned, blocked on the R3 decision.

**Note on the whisper Windows build**: the official `whisper-bin-x64.zip` is a *release* artifact
while macOS ships a *local Metal build* of the same version. They are the same source revision but
different builds, so transcription output parity (SC-003) must be measured, not assumed.

---

## R6. Making tool availability platform-correct (the "one place" requirement)

**Decision**: derive the advertised capability list from the platform layer instead of a static
constant, and replace every hard-coded `darwin` route guard with a capability check.

**Findings (verified in source)**:

| Site | Current state | Problem on Windows |
| --- | --- | --- |
| `packages/shared/src/types.ts:483` `AGENT_CAPABILITIES` | static array including `finder-image-conversion` | a Windows agent would advertise a macOS-only capability it cannot serve |
| `apps/agent/src/compressor/routes.ts:48` | `if (process.platform !== 'darwin') → 501` on `/api/files/select` | the native picker **is** implemented for win32 (`files/picker.ts`) and `capabilities().nativeFilePicker` is already `true` there — the route contradicts the platform layer and silently disables FR-010 |
| `apps/agent/src/media-actions/routes.ts:21` | `if (process.platform !== 'darwin') → 501` | correct behaviour, but expressed as a platform check rather than a declared capability |
| `apps/agent/src/server/app.ts:196` `/health` | already returns `capabilities: [...]` | the transport for platform capabilities already exists — no new endpoint needed |

**Design**: `AGENT_CAPABILITIES` becomes a function of `capabilities()` from
`apps/agent/src/platform/platform.ts`. `finder-image-conversion` is emitted only where
`revealInFileManager`-class Finder integration exists; `native-file-picker` is emitted from
`capabilities().nativeFilePicker`. Routes gate on the capability, not the platform. The web reads
the same list it already reads (`App.tsx:434`, `TranscriptionPage.tsx:111` consume
`capabilities.includes(...)` today), so no new client mechanism is introduced.

**Non-issue found**: job *pausing* is internal only — `queue.ts:1170-1199` pauses the estimator
child so a prioritized job can run, and already falls through cleanly on platforms without
`SIGSTOP` ("Platforms without pause support (Windows) fall through"). There is **no user-facing
pause control** in the web UI, so FR-014's pause clause needs no UI work; it is satisfied by the
existing fallback plus a test.

**Alternatives considered**: a separate `/platform` endpoint — rejected, `/health` already
carries `capabilities` and `normalizeToolContracts` tolerates unknown capability strings, so
extending the list is backward compatible with older web clients.

---

## R7. Enforcing "one place" mechanically (FR-020)

**Decision**: an ESLint `no-restricted-syntax` rule banning `process.platform` in
`apps/agent/src/**` with an override for `apps/agent/src/platform/**`, plus an allowance for
`scripts/**` (build-time, not product code).

**Rationale**: the constitution's Principle IV and the platform module's own doc comment already
state the intent ("every OS-specific mechanism … lives behind these pure functions"); nothing
enforces it. The flat ESLint config (`eslint.config.mjs`) already carries per-path overrides, so
this is a configuration change, not new tooling. Existing violations are exactly the four sites
in R6, all of which this feature removes — so the rule can be turned on without a legacy
allowlist.

**Alternatives considered**: a custom lint plugin or a grep-based CI check — rejected as more
machinery than a built-in rule needs.

---

## R8. Automated Windows verification without a human

**Decision**: a `scripts/windows-smoke.mjs` harness, run on the runner after the installer is
compiled, executing the full install → use → uninstall path unattended; plus the existing
`vitest` suite extended with Windows-shaped unit tests that run on macOS.

**Split of what is automatable** (this is the closed list FR-039 demands):

| Behaviour | Automated on the runner | Why |
| --- | --- | --- |
| Silent install/uninstall, installed layout, Run-key autostart | yes | `iscc` output supports `/VERYSILENT /SUPPRESSMSGBOXES`; registry and filesystem are inspectable |
| Host supervises the agent; `/health` reachable; version/contracts correct | yes | loopback HTTP, same shape as `scripts/real-agent-check.mjs` on macOS |
| Single-instance lock, crash restart (exit 75), kill-host → agent exits via ppid watchdog | yes | process-level, no UI |
| One real job per tool (compress, image convert, transcribe, landing preview, translate) | yes | all are HTTP-driven; fixtures already exist for the macOS e2e harness |
| Archive create/extract via `tar.exe`, `%APPDATA%` resolution, `sanitizeFileName` | yes | pure functions plus filesystem |
| llama.cpp zip layout assumption (R4) | yes | one archive listing |
| **Native chooser dialog: foreground behaviour, multi-select UX, unicode rendering** | **no** | requires an interactive desktop and a real human eye; only spawn arguments and output parsing are unit-testable |
| **SmartScreen / unknown-publisher warning wording and flow** | **no** | reputation-driven, not reproducible in CI |
| **Antivirus quarantine behaviour** | **no** | depends on the end user's security product |
| **Windows Firewall prompt for loopback (expected: silent)** | **no** | policy-dependent |

**Rationale**: this is the honest boundary. Everything left in the "no" column goes on the
FR-038 human-check list and is exercised once, before the first public release, on a rented cloud
Windows desktop or by a recruited waitlist tester (FR-041 makes the waitlist the recruiting pool).

**Alternatives considered**: driving the GUI with WinAppDriver/FlaUI — rejected for the first
release: it would automate exactly one of the four unautomatable items (dialog behaviour) at the
cost of a fragile UI-automation dependency in the release-gating path.

---

## R9. Making Windows release-gating (FR-025)

**Decision**: extend the existing gates rather than add a parallel Windows pipeline.

**Findings (verified in source)**:

- `scripts/verify-release.mjs:89` requires only `artifacts['macos-arm64']` to exist and match
  `RELEASE_DOWNLOAD_URL`; other platforms are validated **only if present** (`:93-99` checks
  https URL + 64-hex sha256 for whatever is listed). Making Windows mandatory is a small,
  symmetric addition: require `artifacts['windows-x64'].url === RELEASE_DOWNLOAD_URL_WINDOWS`.
- `scripts/verify-published-release.mjs` HEADs `RELEASE_DOWNLOAD_URL` only; it must HEAD both.
- `scripts/sign-release-manifest.mjs` already accepts `--platform windows-x64` and records the
  checksum before re-signing, so the tamper-evidence path (FR-024) needs no change.
- **Documentation defect found**: `docs/WINDOWS.md` step 8 tells the reader to edit
  `apps/web/public/.well-known/soty/stable.json`; the real path is
  `apps/web/public/.well-known/wishly/stable.json` (verified — `soty/` does not exist). Following
  the doc as written would silently edit nothing.

**Rationale**: the constitution's Principle II makes `release.ts` the single origin; both
artifact names and URLs are already exported there (`RELEASE_ARTIFACT_NAME_WINDOWS`,
`RELEASE_DOWNLOAD_URL_WINDOWS`), so gating is a verification change, not a contract change.

---

## R10. What the Windows user is told about the unsigned installer

**Decision**: no code signing (per the spec); instead, platform-aware first-run guidance in the
download surface, in English and Ukrainian, naming the exact SmartScreen action ("More info" →
"Run anyway").

**Rationale**: this mirrors the current macOS posture — `scripts/package-mac.sh:86` ad-hoc signs
(`codesign --force --deep --sign -`) with no Developer ID and no notarization, so mac users
already meet a Gatekeeper prompt. The existing UI already has the surfaces: `LocalAppDialog.tsx`
switches on `currentBrowserPlatform()` and holds a `WindowsComingSoonDialog` that becomes the
fallback when no artifact is published, and `release-manifest.ts:103-127` already resolves a
per-platform download with an `available` flag. Only copy and a guidance panel are new.

**Consequence to accept**: an unsigned, low-reputation installer will show SmartScreen warnings
to every early downloader, and some antivirus products will flag a freshly published unsigned
binary. SC-009 covers the guidance; the conversion cost is a business decision already taken.
