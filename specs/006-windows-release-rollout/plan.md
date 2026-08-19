# Implementation Plan: Windows Release Rollout

**Branch**: `006-windows-release-rollout` _(Spec Kit feature context; the working Git branch is
`beta` and is not changed, because no branch hook is configured)_ | **Date**: 2026-08-19 |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-windows-release-rollout/spec.md`

## Summary

Ship Soty to Windows users as a free, unsigned x64 installer with the same tool set as macOS, and
make Windows a mandatory, release-gating artifact produced entirely by CI — because the maintainer
owns no Windows machine.

The port itself is largely written already: `apps/agent/src/platform/platform.ts` isolates the
OS-specific mechanisms, `files/picker.ts` has a win32 branch, `scripts/stage-windows-runtime.mjs`
builds the payload, `packaging/windows/SotyAgentHost` is the tray host, `packaging/windows-installer.iss`
is the installer, and `release.ts` already exports the Windows artifact name and URL. What is
missing is (a) the binaries, (b) a build that runs without a Windows machine, (c) four
platform-gating defects that would disable working features on Windows, and (d) release gates that
refuse to ship macOS alone.

The approach is deliberately additive: one new CI workflow, one input-mirroring workflow, one
fetch script, one smoke harness, a capability-driven replacement for four `process.platform`
guards, a lint rule to keep them from coming back, and symmetric additions to the two existing
release verifiers. No new runtime architecture, no new client mechanism — the agent already
advertises `capabilities` on `/health` and the web already consumes it.

## Technical Context

**Language/Version**: TypeScript 5.9 (`strict`, ESM `NodeNext`, target ES2022) for agent/web/shared;
Node.js 22 for the agent runtime and all `.mjs` scripts; C# / .NET 8 (WinForms) for the Windows tray
host; Inno Setup 6 script for the installer; zsh for the existing macOS packaging scripts.

**Primary Dependencies**: Fastify (agent HTTP), React + Vite (web), Playwright Chromium Headless
Shell (landing preview), FFmpeg/FFprobe (compression), whisper.cpp + Silero VAD (transcription),
llama.cpp + TranslateGemma (translation), Supabase (auth/analytics), Inno Setup (`iscc`) and
.NET SDK on the runner.

**Storage**: per-user application data under `appSupportRoot()` — `%APPDATA%\Soty` on Windows,
`~/Library/Application Support/Soty` on macOS; queue state, imported media, caches and downloaded
models live there and must survive updates.

**Testing**: Vitest (central `tests/`, `*.test.ts(x)`, jsdom via docblock) for unit/integration,
including Windows-shaped tests that run on macOS with stubbed spawn; a new
`scripts/windows-smoke.mjs` unattended install→use→uninstall harness executed on the CI runner;
the existing `scripts/real-agent-check.mjs` remains the macOS e2e harness.

**Target Platform**: Windows 10 (1809+) and Windows 11, **x64 only**; macOS arm64 unchanged. ARM
Windows and 32-bit are out of scope.

**Project Type**: desktop application (local Fastify agent + supervising native host) paired with a
hosted web front end, inside an npm-workspaces monorepo.

**Performance Goals**: full Windows release pipeline (build → stage → publish host → compile
installer → unattended verification → artifact upload) under 60 minutes unattended, per SC-011;
pairing usable within 10 seconds of app start, per User Story 1.

**Constraints**: no code signing on either platform (unsigned, free distribution — explicit spec
decision); no maintainer-owned Windows hardware, so every build and verification step must be
runner-executable; every third-party input pinned by sha256 and durable across years; GPL source
archives shipped for the bundled FFmpeg/x264; agent binds loopback only.

**Scale/Scope**: 6 tool modules (compressor, media-actions, landing, landing-preview,
transcription, team-workspace), 2 platforms, 1 release channel; roughly 4 defect fixes, 4 new
scripts, 2 new workflows, 2 verifier extensions, and documentation/attribution updates.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Assessment | Verdict |
| --- | --- | --- |
| **I. Type-Safe Contracts, Validated at the Boundary** | The input manifest (`packaging/windows/inputs.json`) is untrusted-at-the-boundary data: `fetch-windows-inputs.mjs` must narrow it explicitly and refuse anything whose sha256/size does not match, rather than trusting the JSON. Capability strings stay a `const` union in shared. No new `any`. | PASS |
| **II. One Source of Truth for the Release & Protocol Contract** | Everything Windows-facing already derives from `release.ts` (`RELEASE_ARTIFACT_NAME_WINDOWS`, `RELEASE_DOWNLOAD_URL_WINDOWS`, `ReleasePlatform`). The plan adds no new version constant; the CI workflow reads identity via `scripts/release-meta.mjs`, and the installer version is rendered, not typed. Shared is rebuilt before any script consumes the contract. | PASS |
| **III. Security and Least Privilege by Construction** | No new database surface, no new secret. Two new trust decisions: third-party binaries (mitigated by sha256 pinning + a self-owned mirror, R2) and an installer requiring elevation to write `{autopf}` (already the template's design; the autostart Run key stays HKCU). The agent remains loopback-only. Nothing weakens the existing origin/token/entitlement posture. | PASS |
| **IV. Disciplined Child-Process & Resource Orchestration** | The port's whole point. New spawns (PowerShell pickers, host→node) follow `shell: false` and bounded stderr; `scripts/lib/agent-staging.mjs:47` already sets `shell: process.platform === 'win32'` for npm — a documented, necessary exception for `npm.cmd`, not a new one. Windows lacks `SIGSTOP`; `pauseProcess` already returns `false` and the queue already falls through. | PASS |
| **V. Consistent HTTP API & Error Conventions** | Capability-gated routes keep returning `501` with a stable machine code; the `/health` `capabilities` array is extended, not reshaped. No new response envelope. | PASS |
| **VI. Frontend Composition & State Discipline** | Web changes are confined to `LocalAppDialog.tsx` (platform-aware download + first-run guidance) and new `TranslationKey` entries in `i18n.ts`. No new global store, no new fetching path. `i18n.ts` is already flagged in the constitution as a debt file — additions must not grow its responsibilities. | PASS |

**Development-workflow obligations this plan inherits**: `format:check`, `lint`, `test` must pass
locally; `apps/agent` must be built explicitly because CI never builds it; real-binary tests must
use `it.skipIf`, never `if (!available) return`. The plan's new CI workflow narrows — but does not
close — the "green main is not verified" gap noted in the constitution, and that is called out as a
deliberate partial improvement rather than a claim of full CI coverage.

**Result**: no violations. Complexity Tracking is therefore empty and omitted.

### Post-design re-check (after Phase 1)

Re-evaluated against the artifacts in `research.md`, `data-model.md` and `contracts/`:

- **I** — the one new untrusted input (`packaging/windows/inputs.json`) is specified to parse as
  `unknown` with an explicit guard and ordered size→hash→member validation
  ([windows-inputs.md](./contracts/windows-inputs.md)). No cast, no `any`.
- **II** — no new version constant appeared during design. `windows-inputs-<n>` is a mirror tag for
  build inputs, deliberately separate from release identity, and the release contract gains a
  *rule*, not a field ([release-gates.md](./contracts/release-gates.md)).
- **III** — design added one trust decision (third-party binaries), answered by sha256 pinning plus
  a self-owned immutable mirror, and no new privilege beyond the installer elevation the existing
  template already requires.
- **IV** — the capability contract removes four platform branches from tool code and confines
  `process.platform` to the platform layer, with a lint rule to hold the line.
- **V** — capability-gated routes keep `501` + stable machine codes; the `/health` payload is
  extended, not reshaped.
- **VI** — web changes remain confined to one component plus i18n keys.

Still no violations; the design did not introduce complexity requiring justification.

## Project Structure

### Documentation (this feature)

```text
specs/006-windows-release-rollout/
├── plan.md              # This file
├── research.md          # Phase 0 output — R1..R10, all unknowns resolved
├── data-model.md        # Phase 1 output — entities, fields, state, validation
├── quickstart.md        # Phase 1 output — how to validate the feature end to end
├── contracts/           # Phase 1 output
│   ├── README.md
│   ├── windows-inputs.md       # build-input manifest contract
│   ├── agent-capabilities.md   # platform capability contract (agent ↔ web)
│   └── release-gates.md        # release manifest + verification contract
├── checklists/
│   └── requirements.md
├── spec.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.github/workflows/
├── release-windows.yml           # NEW — build+verify+publish the Windows artifact (windows-2022)
└── mirror-windows-inputs.yml     # NEW — one-shot: mirror pinned inputs into windows-inputs-<n>

packaging/
├── windows-installer.iss         # EXISTS — installer template (rendered by render-launcher.mjs)
└── windows/
    ├── inputs.json               # NEW — pinned third-party build inputs (url, sha256, size, provenance)
    ├── README.md                 # UPDATE — replace the manual checklist with the CI pipeline
    └── SotyAgentHost/            # EXISTS — .NET 8 WinForms tray host
        ├── HostConfig.template.cs
        ├── Soty.ico              # EXISTS — wire up <ApplicationIcon> + NotifyIcon
        └── ...

scripts/
├── fetch-windows-inputs.mjs      # NEW — download + sha256-verify inputs from the mirror
├── windows-smoke.mjs             # NEW — unattended install → tools → update → uninstall harness
├── verify-windows-package.mjs    # NEW — staged/installed layout + architecture checks
├── stage-windows-runtime.mjs     # EXISTS — payload staging (already platform-neutral)
├── verify-release.mjs            # UPDATE — require the windows-x64 artifact (release-gating)
├── verify-published-release.mjs  # UPDATE — HEAD both platform URLs
└── lib/agent-staging.mjs         # EXISTS — lockfile-exact dependency staging, shared with macOS

apps/agent/src/
├── platform/platform.ts          # EXISTS — the one place OS differences live
├── server/app.ts                 # UPDATE — advertise platform-derived capabilities on /health
├── compressor/routes.ts          # UPDATE — gate /api/files/select on capability, not darwin
├── media-actions/routes.ts       # UPDATE — gate on capability, not darwin
└── translation/tools.ts          # UPDATE — pin the win32-x64 sha256/size

packages/shared/src/
└── types.ts                      # UPDATE — AGENT_CAPABILITIES becomes platform-derived

apps/web/src/
├── components/LocalAppDialog.tsx # UPDATE — real Windows download + first-run guidance
└── i18n.ts                       # UPDATE — en/uk copy for the unsigned-installer guidance

tests/                            # UPDATE — platform-layer, capability, picker, inputs-manifest,
                                  #          translation-descriptor and release-gate tests
docs/WINDOWS.md                   # REWRITE — CI pipeline; fix the `.well-known/soty/` path defect
THIRD_PARTY_NOTICES.md            # UPDATE — whisper.cpp section (missing today) + Windows builds
eslint.config.mjs                 # UPDATE — ban process.platform outside the platform layer
```

**Structure Decision**: no new project or package. The feature lands in the existing monorepo
seams — the agent's platform layer and tool modules, the shared contract, the web download surface,
the `scripts/` release tooling, and `packaging/windows/` — plus two new GitHub Actions workflows.
This is what makes FR-017/FR-019 ("add or fix a tool in one place") true by construction: a tool is
written once in `apps/agent/src/<tool>/`, and every OS difference it needs comes from
`apps/agent/src/platform/platform.ts`.

## Implementation Phases

Ordered so each phase leaves the repository shippable, and so the two riskiest unknowns are
resolved first.

**Phase A — Unblock the inputs (highest risk first).** Confirm a static win64 GPL FFmpeg from the
7.1.x line is obtainable (R3) and determine the whisper.cpp version macOS bundles (R5); mirror all
inputs into `windows-inputs-1` and write `packaging/windows/inputs.json`. If 7.1.x proves
unobtainable, the fallback decision is taken here, before any pipeline work depends on it.

**Phase B — Correctness on Windows.** Pin the llama.cpp win32-x64 checksum (R4, values already
determined); make `AGENT_CAPABILITIES` platform-derived; replace the four `process.platform` guards
with capability checks; add the ESLint rule; extend the test suite with the macOS-runnable Windows
tests. Ships value on its own — a correctly-gated agent — with no Windows machine involved.

**Phase C — Build it in CI.** `fetch-windows-inputs.mjs`, then `release-windows.yml` chaining
build → stage → render `HostConfig.cs` → `dotnet publish` → render + compile the installer →
`verify-windows-package.mjs` → artifact upload. Ends with a downloadable installer per run.

**Phase D — Verify it in CI.** `windows-smoke.mjs` covering install, autostart, pairing, one job
per tool, host-kill/ppid-watchdog, crash restart, update-over-install, and uninstall; wire it into
the workflow as a release gate. This is where the llama.cpp zip-layout assumption gets its
assertion.

**Phase E — Make it releasable.** Extend `verify-release.mjs` and `verify-published-release.mjs` to
require both artifacts; publish the Windows artifact to the same immutable tag; record its checksum
via the existing `sign-release-manifest.mjs --platform windows-x64`; update `THIRD_PARTY_NOTICES.md`
and rewrite `docs/WINDOWS.md`.

**Phase F — Roll out.** Web download surface and first-run guidance (en/uk); the FR-038 human-check
pass on a rented cloud Windows desktop or a recruited waitlist tester; limited pre-release with real
Windows users; then open the download to all Windows visitors and notify the waitlist.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| No static win64 GPL FFmpeg 7.1.x obtainable (R3) | Output parity (SC-003) unprovable, or both platforms must move FFmpeg version — a separate spec | Resolved in Phase A before anything depends on it; fallback is a newer line plus an explicit encoder parity test |
| Windows becomes release-gating, so a broken Windows build blocks macOS releases too | A CI or upstream hiccup stops all shipping | Accepted by the maintainer and recorded in the spec's Assumptions; mitigated by the self-owned input mirror removing upstream flakiness from the critical path |
| Unsigned installer trips SmartScreen and antivirus | Download-to-install conversion loss, support load | Explicit spec decision; mitigated by first-run guidance (SC-009) and measured via platform-attributed analytics (FR-040) |
| GUI-dependent behaviours cannot be verified in CI | Four behaviours ship unverified by machine | Closed written list (FR-039) checked once by a human before first public release (FR-038) |
| Windows runner GUI/session limits break the smoke harness | Phase D gate unusable | Harness drives the agent over loopback HTTP and the installer silently; only the tray host needs a session, and its supervision is checked by process/HTTP assertions, not UI automation |
