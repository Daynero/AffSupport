# Implementation Plan: Video Stitcher

**Branch**: `014-video-stitcher` (work continues on `011-team-workspace-rework` until a
branch is cut) | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/014-video-stitcher/spec.md`

## Summary

A new local tool that replaces, adds, or removes the static photo screens at the edges of a
video without re-encoding the video. The user picks a video and a photo and presses start;
the tool decides by itself whether that is a stitch or a re-stitch, rebuilds only the
screens, and joins them to the untouched body.

The technical shape, settled by measurement in [research.md](./research.md): read the
source's own parameters with `ffprobe`; prepare its body **once** (a stream-copy remux that
zeroes timestamps, plus — only when the body's first frame is not a keyframe — a re-encode
of the single group of frames at the cut point); render the new screens to exactly those
parameters (end screen at 1 fps, start screen ≥ 2 frames, silence sliced by whole AAC frames
from a cached ADTS bank); join everything with the concat demuxer and `-c copy
-movflags +faststart`; probe the result and refuse to hand over a file that does not match
what was promised. Measured end to end: **≈ 2.3 s** for the first touch of a 50-second
1080×1080 legacy creative, **≈ 0.6 s** for every photo after that.

## Technical Context

**Language/Version**: TypeScript 5.9, `strict: true`, ESM `NodeNext` (internal imports carry
`.js`), target ES2022. Node ≥ 22.12.

**Primary Dependencies**: Fastify (agent HTTP), React + Vite (web), FFmpeg/ffprobe (bundled
in packaged builds under `runtime/bin`, on `PATH` in development — 9.0.1 on the bench),
`@video-compressor/shared` for the contract. No new npm dependency.

**Storage**: local files only. A prepared-body cache and the AAC silence banks live under the
agent's Application Support root (`apps/agent/src/files/support-dir.ts`), alongside the
existing image store; job state persists like the other queues.

**Testing**: vitest in the central `tests/` directory, `*.test.ts(x)`; jsdom docblock for
DOM tests; real-binary tests gated with `it.skipIf` (never a silent `return`). Run with
`--maxWorkers=1 --minWorkers=1 --no-file-parallelism` on this machine.

**Target Platform**: macOS (arm64/x64) and Windows x64 — the agent's existing platforms. The
web half is Cloudflare Pages as today.

**Project Type**: monorepo — local agent + web app + shared contract.

**Performance Goals**: SC-001 — stitch / re-stitch / remove in under 5 s p95 for videos up to
10 minutes; SC-002 — cost independent of screen duration (a 45 s end screen must not cost
more than a 3 s one).

**Constraints**: never re-encode the body except the bounded head case in D6; every output
verified before it is reported successful; one heavy child process at a time through the
existing `PowerGovernor`; no new network surface; local paths only through the existing
`pathGrants`.

**Scale/Scope**: single user, one job at a time, batches of tens of photos against one video.
New surface: ~1 agent module (7 files), ~1 web page (5 components), ~1 shared contract file,
~8 test files.

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design.*

| Principle | How this feature satisfies it |
| --- | --- |
| **I. Type-safe contracts, validated at the boundary** | All stitcher types, bounds and validators live in `packages/shared/src/stitcher.ts`. Every `ffprobe` payload is typed `unknown` and narrowed by an explicit guard into `SourceProfile` — the source of truth for every downstream decision — and returns `{ ok: true; value } | { ok: false; error }`. Operation and job state are string-literal unions (`StitchOperation`, `STITCH_LIFECYCLE`), never booleans. |
| **II. One source of truth for the release & protocol contract** | `AGENT_TOOL_CONTRACTS.stitcher = 1` and `WEB_TOOL_REQUIREMENTS.stitcher` are added in `release.ts` and nowhere else. **Release consequence, deliberate:** `verify-release.mjs:83` byte-compares `WEB_TOOL_REQUIREMENTS` against the signed `stable.json`, so `deploy:web` fails until an agent release publishes a manifest carrying the new map — the tool ships with an agent release, not ahead of one. Shared is rebuilt before anything reads the contract. |
| **III. Security & least privilege** | No new network surface, no new secret, no database. File access goes through the existing `pathGrants`; the routes sit behind the same origin allowlist, session token and entitlement gate as the compressor. Cache directories are created under the Application Support root with the same permissions as the image store. |
| **IV. Disciplined child-process & resource orchestration** | Every FFmpeg/ffprobe run is `spawnManaged` with `shell: false` and an argument array, resolving `{ code, stderr, spawnErrorCode }` rather than rejecting; stderr is `slice(-N)`-bounded; cancellation holds the live child and escalates SIGTERM → SIGKILL; every intermediate file is written under `mkdtemp` with `try/finally` cleanup; the prepared-body cache is installed by staging to a temp path then `rename`. The D8 hazard (a looped image shorter than one frame period hangs FFmpeg) is enforced in the argument builder, not left to the caller. |
| **V. Consistent HTTP API & error conventions** | `registerStitcherRoutes(app, ctx)` plus a `ToolModule` entry in `createToolModules` — routes, the `/health` busy flag, `cancel`/`cancelAll` and the shutdown chain all follow. Success returns the tool's state snapshot; failures return `reply.code(N).send({ error })` with stable machine codes (`STITCH_SOURCE_UNSUPPORTED`, `STITCH_NOTHING_TO_REMOVE`, `STITCH_VERIFICATION_FAILED`, …), never sentences. |
| **VI. Frontend composition & state discipline** | One context store with a `useStitcher()` hook and an override for tests, `api/client.ts` wrappers for every call, the single SSE subscribe path for live state, `useI18n()` keys (compile-checked `TranslationKey`), `analytics.track` with a typed event name, `className` against `styles.css`. No `any` in `src`. |

**Post-design re-check**: still passing. The two additions that needed justification (a
persistent prepared-body cache and the bounded head re-encode) are recorded in
[Complexity Tracking](#complexity-tracking); neither introduces a new pattern, a new
dependency, or a new trust boundary.

## Project Structure

### Documentation (this feature)

```text
specs/014-video-stitcher/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — measured decisions D1…D10
├── data-model.md        # Phase 1 output — entities and state
├── quickstart.md        # Phase 1 output — how to prove it works
├── contracts/
│   ├── agent-http.md    # Agent routes, payloads, error codes
│   └── shared-types.md  # The contract surface added to @video-compressor/shared
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 — created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
packages/shared/src/
├── stitcher.ts                  # NEW — operations, job, settings, lifecycle, bounds, guards
├── release.ts                   # EDIT — AGENT_TOOL_CONTRACTS.stitcher, WEB_TOOL_REQUIREMENTS.stitcher
└── types.ts                     # EDIT — AGENT_CAPABILITIES += 'stitcher'; screen settings reused as-is

apps/agent/src/
├── stitcher/
│   ├── routes.ts                # NEW — registerStitcherRoutes(app, ctx), state snapshot, SSE
│   ├── queue.ts                 # NEW — StitchQueue: one run at a time, cancel, persistence
│   ├── probe.ts                 # NEW — ffprobe → SourceProfile (+ keyframe map), unknown-narrowed
│   ├── plan.ts                  # NEW — pure: detected edges + profile → StitchPlan (operation, cuts, snapped durations)
│   ├── body-cache.ts            # NEW — prepared bodies under Application Support, keyed by source identity
│   ├── silence.ts               # NEW — ADTS silence banks per (sample rate, channels), built once
│   ├── segments.ts              # NEW — screen segments and the prepared body, via the arg builders
│   └── verify.ts                # NEW — post-run ffprobe comparison with tolerances
├── ffmpeg/
│   └── stitch-presets.ts        # NEW — pure argument builders (screen, silence slice, remux, head re-encode, concat)
├── server/tools.ts              # EDIT — one more ToolModule entry
├── server/capabilities.ts       # EDIT — advertise 'stitcher'
└── index.ts                     # EDIT — construct the queue, wire its SSE channel

apps/web/src/
├── stitcher/
│   ├── StitcherPage.tsx         # NEW — pick video → pick photo → start
│   ├── StitcherContext.tsx      # NEW — state store + SSE subscription
│   ├── StitchPlanLine.tsx       # NEW — the one line: what was found, what will be produced, resulting length
│   ├── StitchQueueList.tsx      # NEW — per-item progress, result, failure
│   └── api.ts                   # NEW — typed client wrappers
├── lib/tool-registry.ts         # EDIT — the 'stitcher' entry (icon, route, capability, flag)
├── lib/feature-flags.ts         # EDIT — 'videoStitcher' flag, protected until release
├── components/tool-icons.tsx    # EDIT — StitcherIcon
├── analytics/events.ts          # EDIT — 'stitcher' analytics tool id and its events
└── i18n.ts                      # EDIT — the tool's keys (en + uk)

tests/
├── stitch-presets.test.ts       # arg builders, including the D8 sub-frame guard
├── stitch-plan.test.ts          # operation inference, AAC snapping, keyframe decisions
├── stitch-probe.test.ts         # ffprobe narrowing, malformed payloads
├── stitch-queue.test.ts         # lifecycle, cancel, failure isolation in a batch
├── stitch-routes.test.ts        # HTTP contract and error codes
├── stitch-verify.test.ts        # tolerance boundaries (45 ms passes, 2 s fails)
├── stitch-integration.test.ts   # real FFmpeg, it.skipIf(!available): stitch → probe → re-stitch → unstitch
└── stitcher-page.test.tsx       # jsdom: pick, plan line, start, per-item results
```

**Structure Decision**: the monorepo's existing three-part layout, extended by one agent tool
module, one web tool page, and one shared contract file — the same shape the transcription
tool took. The compressor is read for its conventions (destination, naming, screen library)
and reused through those modules; none of its own pipeline is modified, which keeps the
in-flight release untouched.

## Phase 1 design decisions worth carrying into tasks

1. **The plan is computed before anything runs.** `plan.ts` is pure: given a `SourceProfile`,
   the detected static edges, and the user's screen choices, it returns the operation, the
   cut points, the AAC-snapped screen durations, whether a head re-encode is needed, and the
   promised output duration. Everything the UI shows in one line and everything `verify.ts`
   checks afterwards comes from this one object, so the promise and the check can never
   drift apart.
2. **Reuse, not reimplementation.** `detectStaticEdgeTrims` (edge detection),
   `imageAdaptationFilter` (fit modes), `ImageAssetStore` (the photo library and its
   enabled/disabled state), `nextOutputPath` (naming), the compressor's destination choices,
   `spawnManaged`/`PowerGovernor`, and `pathGrants` are all used as they are.
3. **The cache is invisible but bounded.** Keyed on (absolute path, size, mtime, cut points);
   an LRU with a size ceiling; a miss simply costs the preparation again. It is never
   surfaced in the UI (FR-018) and never required for correctness.
4. **Batching is one photo per run.** The queue runs one job at a time so the power governor
   keeps its single-heavy-process guarantee; a batch of N photos against one prepared body is
   N jobs that each cost the ~0.6 s of D9.
5. **Declining is a first-class outcome.** `STITCH_SOURCE_UNSUPPORTED` carries the specific
   reason (codec, variable frame rate, unreadable track layout) and the UI turns it into one
   sentence plus a link to the compressor (FR-023). No silent slow path.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| A persistent prepared-body cache (new on-disk artifact under Application Support) | FR-018 and SC-005: the second and later photos against the same video must cost ~0.6 s, and the only way is to keep the prepared body between runs | Re-preparing per photo re-pays the head re-encode (measured 1.63 s) on every variant, turning a 20-photo batch from ~12 s into ~45 s; an in-memory cache loses it on every agent restart, which is exactly when a batch is resumed |
| A bounded head re-encode inside a "never re-encode" tool | Measured D6: real creatives have keyframes only every ~8.3 s and none at the body boundary, so a stream copy cannot start there | Keyframe-only cuts either leave the old photo frame visible or discard up to 8.3 s of real content; declining every such file would decline nearly the whole existing library, which defeats the feature's primary user story |
