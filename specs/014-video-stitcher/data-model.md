# Phase 1 Data Model: Video Stitcher

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Measurements**:
[research.md](./research.md)

Every type below lives in `packages/shared/src/stitcher.ts` unless stated otherwise, so the
agent and the web app read one definition (Principle I). Values that cross a process
boundary are narrowed by an explicit guard; nothing is cast.

---

## SourceProfile

What the source video actually is. Produced by `apps/agent/src/stitcher/probe.ts` from
`ffprobe` output typed `unknown`, and the sole input to every later decision — the screens
are rendered to these numbers (D5).

| Field | Type | Notes |
| --- | --- | --- |
| `path` | `string` | Absolute, already granted through `pathGrants` |
| `sizeBytes`, `modifiedAtMs` | `number` | Together with `path`, the cache key |
| `container` | `string` | `mov,mp4,m4a,…`; anything else is declined |
| `videoCodec` | `string` | Must be `h264` for the fast path |
| `profile`, `level` | `string`, `number` | Screens are encoded to the same profile |
| `width`, `height` | `number` | Screens are rendered at exactly this size |
| `pixelFormat` | `string` | `yuv420p` expected; drives the screen's `format=` |
| `colorRange` | `'tv' \| 'pc' \| 'unknown'` | D5 — a JPEG photo is full-range and must be converted |
| `frameRate` | `number` | Rational reduced to a number; a variable rate is declined |
| `videoTimescale` | `number` | Screens and remuxes are muxed with the same `-video_track_timescale` |
| `durationSeconds` | `number` | Container duration |
| `hasAudio` | `boolean` | No audio ⇒ silent screens, no audio track invented (FR-012 edge case) |
| `audioCodec` | `string \| null` | `aac` for the fast path |
| `audioSampleRate`, `audioChannels` | `number \| null` | Select the silence bank (D4) |
| `keyframeTimes` | `number[]` | Presentation times of every keyframe; drives the head decision (D6) |

**Validation**: a profile that fails any fast-path condition (non-H.264, non-AAC audio,
variable frame rate, unreadable tracks) never becomes a plan — the route answers
`STITCH_SOURCE_UNSUPPORTED` with the specific reason (FR-023).

---

## DetectedStitching

What the tool found at the edges, from `detectStaticEdgeTrims` refined to frame precision.

| Field | Type | Notes |
| --- | --- | --- |
| `startSeconds` | `number` | Length of the leading static run; `0` when there is none |
| `endSeconds` | `number` | Length of the trailing static run; `0` when there is none |
| `adjustedByUser` | `boolean` | True once the user has moved a boundary (FR-007) |

---

## StitchScreens

The user's screen choices. Reuses the compressor's existing `ImageAsset` /
`ImageEmbeddingSettings` shapes (`packages/shared/src/types.ts`) rather than a parallel set:
the same library, the same enabled/disabled state, the same fit modes.

| Field | Type | Notes |
| --- | --- | --- |
| `startImageId` | `string \| null` | `null` ⇒ no start screen |
| `endImageId` | `string \| null` | `null` ⇒ no end screen |
| `fitMode` | `ImageFitMode` | `cover \| contain \| stretch`, via `imageAdaptationFilter` |
| `endDurationMode` | `FinalImageDurationMode` | The existing fixed/random modes |
| `customEndDurationSeconds` | `number` | Used when the mode is `custom`; clamped by shared bounds |

---

## StitchPlan

The single object that both promises and is checked (plan.md §1). Pure output of
`apps/agent/src/stitcher/plan.ts` from `SourceProfile` + `DetectedStitching` + `StitchScreens`.

| Field | Type | Notes |
| --- | --- | --- |
| `operation` | `StitchOperation` | Inferred, not asked (FR-027) |
| `bodyStartSeconds`, `bodyEndSeconds` | `number` | The cut points into the source |
| `headReencodeUntilSeconds` | `number \| null` | `null` when the body starts on a keyframe; otherwise the next keyframe time (D6) |
| `startScreen` | `{ frames: number; durationSeconds: number; aacFrames: number } \| null` | ≥ 2 frames at the body's rate (D3) |
| `endScreen` | `{ fps: 1; durationSeconds: number; aacFrames: number } \| null` | Always 1 fps (D2) |
| `promisedDurationSeconds` | `number` | Body + screens, after AAC snapping (D4) |
| `promisedFrameCount` | `number` | Body frames + screen frames |

**Duration snapping rule**: every screen duration is `aacFrames × 1024 / audioSampleRate`, so
a segment's audio and video durations are equal by construction (D4). With no audio track,
the rule degrades to whole video frames.

**State**: a plan is immutable. Adjusting a boundary or a photo produces a new plan; a job
holds the plan it started with.

---

## StitchOperation

```
'stitch'    — no screens found; screens are added
'restitch'  — screens found; they are replaced
'unstitch'  — screens found; they are removed and no new ones added
```

`stitch` and `restitch` are inferred from `DetectedStitching` (FR-027). `unstitch` is the one
the user asks for explicitly; asking for it on a source with no detected screens answers
`STITCH_NOTHING_TO_REMOVE` and produces no file (FR-008).

---

## StitchJob

One run. Persisted like the other queues so a restart does not lose a batch.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | |
| `sourcePath`, `sourceName` | `string` | |
| `plan` | `StitchPlan` | Frozen at start |
| `destination` | `StitchDestination` | Beside the original / chosen folder / overwrite (FR-021) |
| `outputSuffix` | `string` | Empty ⇒ the compressor's automatic numbering (FR-022) |
| `status` | `StitchStatus` | See the lifecycle below |
| `progressStage` | `'preparing' \| 'screens' \| 'joining' \| 'verifying' \| null` | Coarse on purpose: the whole run is seconds |
| `outputPath` | `string \| null` | Set on success |
| `elapsedMs` | `number \| null` | Reported per finished run (FR-019) |
| `error` | `string \| null` | A machine code; the UI renders the sentence |
| `verification` | `StitchVerification \| null` | What the probe actually found |

### STITCH_LIFECYCLE

```
queued → running → done
   ↓        ↓
cancelled  failed
```

Declared on the `ToolModule` as `lifecycle`, the way the constitution's Principle V requires,
so legality lives in one table rather than in each queue's `if` chain.

---

## StitchVerification

Produced by `verify.ts` after every run (D7, FR-011).

| Field | Type | Notes |
| --- | --- | --- |
| `durationSeconds`, `frameCount` | `number` | As measured |
| `videoTrackSeconds`, `audioTrackSeconds` | `number` | Must agree with each other |
| `videoCodec`, `audioCodec`, `width`, `height`, `pixelFormat` | `string`/`number` | Must equal the source's |
| `withinTolerance` | `boolean` | False ⇒ the job fails and the file is discarded |

**Tolerances** (from the measured drifts in D7): container duration may differ from
`promisedDurationSeconds` by up to one AAC frame plus one video frame (~60 ms at 30 fps /
48 kHz); the two track durations may differ by the same; the frame count may differ by one.
Anything larger — the two-second track disagreement observed in the experiments — fails.

---

## PreparedBody (agent-internal, not on the wire)

The cached, keyframe-clean, timestamp-zeroed body (D6). Lives under the agent's Application
Support root beside the image store.

| Field | Type | Notes |
| --- | --- | --- |
| `key` | `string` | Hash of (absolute path, size, mtime, body cut points) |
| `path` | `string` | The cached MP4 |
| `bytes`, `createdAtMs`, `lastUsedAtMs` | `number` | LRU eviction against a size ceiling |
| `headWasReencoded` | `boolean` | Diagnostics only; never shown to the user |

Installed by staging into a `mkdtemp` directory and `rename`-ing into place (Principle IV). A
miss is never an error — it only costs the preparation again.

---

## SilenceBank (agent-internal)

One raw-ADTS AAC silence file per `(sampleRate, channels)`, built once and reused (D4).
Keeping it ADTS is what removes the encoder-priming edit list that otherwise offsets every
segment by ~21 ms.
