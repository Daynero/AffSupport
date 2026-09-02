# Contract: `@video-compressor/shared` additions

One new file, two edits. Nothing here duplicates a constant that already exists; the screen
library, the fit modes and the end-duration modes are the compressor's and are imported, not
restated (Principle II, and plan.md §2).

---

## New: `packages/shared/src/stitcher.ts`

```ts
export type StitchOperation = 'stitch' | 'restitch' | 'unstitch';

export type StitchStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Declared on the ToolModule so legality lives in one table (Principle V). */
export const STITCH_LIFECYCLE = { /* queued → running → done|failed|cancelled */ } as const;

export type StitchUnsupportedReason =
  'video-codec' | 'audio-codec' | 'variable-frame-rate' | 'container' | 'unreadable';

export type StitchDestination =
  | { kind: 'beside' }
  | { kind: 'folder'; path: string }
  | { kind: 'overwrite' };

export interface SourceProfile { /* data-model.md § SourceProfile */ }
export interface DetectedStitching { startSeconds: number; endSeconds: number; adjustedByUser: boolean }
export interface StitchScreens { /* data-model.md § StitchScreens */ }
export interface StitchPlan { /* data-model.md § StitchPlan */ }
export interface StitchJob { /* data-model.md § StitchJob */ }
export interface StitchVerification { /* data-model.md § StitchVerification */ }
export interface StitchSettings { screens: StitchScreens; destination: StitchDestination; outputSuffix: string }
export interface StitcherState { settings: StitchSettings; jobs: StitchJob[]; busy: boolean }

/** The AAC-frame snapping rule from research.md D4 — one definition, used by the
 *  planner, the argument builders and the verifier. */
export function snapToAacFrames(seconds: number, sampleRate: number): { aacFrames: number; seconds: number };

/** Bounds, clamped rather than rejected, matching the compressor's clamp* idiom. */
export const STITCH_END_DURATION_MIN_SECONDS: number;
export const STITCH_END_DURATION_MAX_SECONDS: number;
export function clampStitchEndDuration(value: number): number;

/** Narrowing guards — every one returns a discriminated result, never a cast. */
export function parseSourceProfile(value: unknown): { ok: true; value: SourceProfile } | { ok: false; error: string };
export function parseStitchSettingsPatch(value: unknown): { ok: true; value: Partial<StitchSettings> } | { ok: false; error: string };

/** Pure, shared by the agent (to run) and the web app (to preview) so the promise
 *  shown to the user and the file produced can never come from different maths. */
export function planStitch(
  profile: SourceProfile,
  detected: DetectedStitching,
  screens: StitchScreens,
  operation?: StitchOperation
): { ok: true; value: StitchPlan } | { ok: false; error: StitchUnsupportedReason | 'nothing-to-remove' };
```

**Reused, not redefined**: `ImageAsset`, `ImageEmbeddingSettings`, `ImageFitMode`,
`FinalImageDurationMode`, `finalImageDurationRange`, `randomFinalImageDurationSeconds` — all
from `packages/shared/src/types.ts`.

---

## Edit: `packages/shared/src/release.ts`

```ts
export const AGENT_TOOL_CONTRACTS = {
  …,
  stitcher: 1
} as const;

export const WEB_TOOL_REQUIREMENTS = {
  …,
  stitcher: { stitcher: 1, imageEmbedding: 2 }
} as const;
```

`SotyToolId` derives from `WEB_TOOL_REQUIREMENTS`, so this is also what registers the tool
id for the web registry. **Release consequence**: `scripts/verify-release.mjs:83` compares
this map byte-for-byte with the signed `stable.json`, so `deploy:web` fails until an agent
release publishes the new map — intended, and the reason the tool ships with an agent
release rather than ahead of one.

---

## Edit: `packages/shared/src/types.ts`

```ts
export const AGENT_CAPABILITIES = [ …, 'stitcher' ] as const;
```

Advertised unconditionally by `apps/agent/src/server/capabilities.ts` (no platform
requirement — the tool needs only FFmpeg, which the agent already probes). The web registry
entry uses `capability: 'stitcher'`, so a connected agent that lacks it redirects home
instead of opening a page that cannot work.

---

## Build discipline

`packages/shared/dist` is committed, so anything that reads the contract rebuilds shared
first (`npm run build -w @video-compressor/shared`). Every test, script or command touching
these types validates against current constants, never a stale `dist` (Principle II).
