# Phase 1 Data Model: Windows Release Rollout

**Feature**: `specs/006-windows-release-rollout` | **Date**: 2026-08-19

This feature adds no database tables and no user-facing persisted records. Its "data" is build and
release metadata plus one runtime contract extension. Each entity below maps to the spec's Key
Entities section and names where it lives.

---

## 1. WindowsBuildInput

A single third-party file the Windows installer bundles. Committed at
`packaging/windows/inputs.json`; consumed by `scripts/fetch-windows-inputs.mjs`.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable slug, unique in the manifest. Matches the staging env var it feeds (`node`, `ffmpeg`, `ffprobe`, `whisper-cli`, `whisper-vad-model`, `ffmpeg-source`, `x264-source`). |
| `mirrorUrl` | string | `https://` URL inside this repository's `windows-inputs-<n>` release. The only URL the release build fetches. |
| `upstreamUrl` | string | Original publisher URL. Provenance only — never fetched by the release build. |
| `sha256` | string | Lowercase 64-hex. Verified after download; a mismatch aborts the build. |
| `sizeBytes` | integer | Positive. Checked before hashing so a truncated/hijacked download fails fast and cheap. |
| `archiveKind` | `'raw' \| 'zip' \| '7z' \| 'tar.gz'` | `raw` means the file is the artifact itself (e.g. `node.exe`). |
| `memberPath` | string \| null | Path inside the archive to extract. Required unless `archiveKind` is `raw`. |
| `stagesTo` | string | Destination env var consumed by `scripts/stage-windows-runtime.mjs` (e.g. `FFMPEG_BINARY_WIN`). |
| `license` | string | SPDX-ish identifier for the attribution record. |
| `provenance` | string | Human sentence naming the exact upstream build/version, copied verbatim into `THIRD_PARTY_NOTICES.md`. |
| `sourceArchiveFor` | string \| null | Set on GPL source archives, naming the binary input they correspond to. |

**Validation** (Constitution I — this JSON is untrusted at the boundary):

- The manifest is parsed as `unknown` and narrowed with an explicit type guard; no `as`.
- Every binary input whose `license` implies copyleft MUST have a matching entry with
  `sourceArchiveFor` pointing at it, or the fetch script fails.
- `id` values must be unique; unknown `id`s are an error, not a silent skip.
- Verification order is: size → sha256 → archive member presence. Each failure names the input.

**Lifecycle**: inputs are immutable. Changing a bundled binary means adding entries and minting a
new `windows-inputs-<n+1>` release — never rewriting an existing one.

---

## 2. ReleasePlatformArtifact

One downloadable installer for one platform. Already modelled in
`packages/shared/src/release.ts` (`ReleaseArtifact`, `ReleasePlatform`); this feature makes the
Windows member mandatory rather than optional in practice.

| Field | Type | Rules |
| --- | --- | --- |
| `platform` | `'macos-arm64' \| 'macos-x64' \| 'windows-x64'` | Manifest key. Unknown keys are rejected by `verify-release.mjs`. |
| `url` | string | Must equal `RELEASE_DOWNLOAD_URL` / `RELEASE_DOWNLOAD_URL_WINDOWS` for its platform — never a hand-written URL (Constitution II). |
| `sha256` | string | Lowercase 64-hex of the published file, recorded by `sign-release-manifest.mjs`. |

**State**: `planned` → `built` (artifact exists in the workflow run) → `published` (attached to the
immutable `v<version>` tag) → `recorded` (checksum in `stable.json`) → `signed` (manifest
re-signed). A release may deploy only when **both** platforms reach `signed`.

---

## 3. StableReleaseManifest (existing, tightened)

`apps/web/public/.well-known/wishly/stable.json` — note the real path is `wishly/`, not the
`soty/` that `docs/WINDOWS.md` currently claims. Shape is unchanged
(`StableReleaseManifest` in `release.ts`); the change is a rule, not a field:

- `artifacts` MUST contain both `macos-arm64` and `windows-x64` for a stable release.
- Every listed artifact MUST have an `https://` URL and a complete 64-hex `sha256` (already
  enforced).
- `signature` MUST cover the whole manifest via `releaseManifestSigningPayload` (already enforced).

---

## 4. PlatformCapability (runtime contract extension)

The agent's declaration of what the host OS can do. Source of truth:
`capabilities()` in `apps/agent/src/platform/platform.ts`; transported in the existing
`/health` and handshake `capabilities` array; consumed by the web
(`App.tsx`, `TranscriptionPage.tsx`) and by route guards.

| Capability string | macOS | Windows | Gates |
| --- | --- | --- | --- |
| `local-file-paths` | yes | yes | local-path workflows in the web UI (existing) |
| `native-file-picker` | yes | yes | `POST /api/files/select` |
| `finder-image-conversion` | yes | **no** | `POST /native/media-actions/images/convert` |
| `landing` | yes | yes | landing optimizer |
| `landing-preview` | yes | yes | landing preview rendering |
| `transcription` | yes | yes | transcription + translation |
| `team-workspace` | yes | yes | team workspace |

**Rules**:

- The advertised list MUST be derived from `capabilities()`, not a static constant — today
  `AGENT_CAPABILITIES` (`packages/shared/src/types.ts:483`) is static and would make a Windows
  agent advertise `finder-image-conversion`.
- A route guarded by a capability MUST refuse with `501` and a stable machine code when the
  capability is absent — never a human sentence, never a platform name in the branch.
- Unknown capability strings must remain harmless to older web clients
  (`normalizeToolContracts` already ignores anything it does not know), so the list is additive.

---

## 5. WindowsVerificationRun

The record produced by `scripts/windows-smoke.mjs` on each release build. Not persisted beyond the
workflow run and its logs; modelled so the gate is unambiguous.

| Field | Type | Rules |
| --- | --- | --- |
| `buildId` | string | From `release-meta.mjs`; must equal the installed app's reported `buildId`. |
| `checks` | array of `{ id, status, detail }` | `status` ∈ `passed \| failed \| skipped`. |
| `skipped` | array of string | MUST be empty on a release build — a skipped check is a failed gate, never a silent pass (constitution's anti-pattern about tests that "pass" when a tool is absent). |
| `unverifiedRisks` | array of string | The closed FR-039 list, emitted verbatim so it is visible in every run. |

**Required checks** (each maps to a spec requirement): silent install; installed layout; Run-key
autostart; host starts agent; `/health` reachable with matching version/buildId/apiVersion/tool
contracts; advertised capabilities exactly match the Windows expectation (no
`finder-image-conversion`); one job per tool; llama.cpp archive layout; single-instance lock;
crash restart; kill-host → agent exits; update-over-install preserves data; silent uninstall
removes program files and the Run key.

---

## 6. UnverifiedRisk

The closed list FR-038/FR-039 require. Lives in `docs/WINDOWS.md` and is echoed by every
verification run.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable slug. |
| `behaviour` | string | What cannot be machine-verified. |
| `why` | string | Why automation cannot cover it. |
| `checkedBy` | string \| null | Who performed the human check, and when. Must be non-null for every entry before the first public Windows release. |

**Initial contents** (from research R8): native chooser dialog foreground/multi-select/unicode
behaviour; SmartScreen unknown-publisher flow; antivirus quarantine behaviour; Windows Firewall
prompt for loopback listening.

**Rule**: the list may only grow through a deliberate edit — anything discovered to be
unverifiable must be added here rather than left implicit.
