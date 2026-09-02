# Contract: Agent HTTP surface — `stitcher`

**Module**: `apps/agent/src/stitcher/routes.ts`, registered as
`registerStitcherRoutes(app, ctx)` and appended to `createToolModules` in
`apps/agent/src/server/tools.ts`.

All routes inherit the agent's existing posture: origin allowlist, session token,
entitlement gate, and `acceptingNewTasks()` (a pending update drains work — new runs are
refused with `UPDATE_PENDING`, exactly as the other tools do). Success returns the tool's
state snapshot; failure returns `reply.code(N).send({ error })` where `error` is a stable
machine code, never a sentence (Principle V).

---

## `GET /api/stitcher`

The snapshot: settings, the jobs list, and whether the tool is busy.

```
200 → StitcherState {
  settings: StitchSettings,
  jobs: StitchJob[],
  busy: boolean
}
```

## `POST /api/stitcher/inspect`

Everything the one-line preview needs, computed before anything runs (FR-007, FR-028).
Cheap: an `ffprobe` pass plus the existing static-edge detector.

```
body → { path: string, screens: StitchScreens, operation?: StitchOperation }
200  → { profile: SourceProfile, detected: DetectedStitching, plan: StitchPlan }
400  → { error: 'STITCH_PATH_INVALID' }         path missing, not a file, or not granted
415  → { error: 'STITCH_SOURCE_UNSUPPORTED', reason: StitchUnsupportedReason }
409  → { error: 'STITCH_NOTHING_TO_REMOVE' }    unstitch asked of a source with no screens
503  → { error: 'MEDIA_TOOL_UNAVAILABLE' }      ffmpeg/ffprobe missing
```

`StitchUnsupportedReason` = `'video-codec' | 'audio-codec' | 'variable-frame-rate' |
'container' | 'unreadable'`. The web app maps each to one sentence plus the link to the
compressor (FR-023); the agent never sends prose.

## `POST /api/stitcher/files`

Add rows to the list. This is the compressor's model: a chosen file becomes a `ready` row
that has not run, so rows can be selected and started as a batch.

Each path gets one cheap `ffprobe` of its container — enough for the row's figures and to
refuse a file the fast path cannot serve. The keyframe index and the search for screens
already on the file cost seconds on a long video and belong to the run: a dropped file appears
in the list at once, and `detected` on a new row is `null` until it has been run.

```
body → { paths: string[] }
200  → { state: StitcherState, refused: { path: string, reason: StitchUnsupportedReason }[] }
400  → { error: 'STITCH_PATH_INVALID' }         no usable absolute local path in the list
403  → { error: 'PATH_NOT_GRANTED' }
503  → { error: 'MEDIA_TOOL_UNAVAILABLE' }
```

A file the tool cannot serve does not fail the call — it is named in `refused` and the rest
are added, so one bad file in a drop does not lose the others (FR-020).

## `POST /api/stitcher/start`

Run the chosen rows, one at a time. The plan is decided here rather than when the file was
added, so a setting changed in between is the setting that runs, and a random screen length
is drawn once per row.

```
body → { ids: string[], operation?: StitchOperation }   // omitted ⇒ 'restitch'
202  → { state: StitcherState, failures: { id: string, error: StitchPlanFailure }[] }
400  → { error: 'STITCH_NOTHING_SELECTED' }
409  → { error: 'UPDATE_PENDING' }
503  → { error: 'MEDIA_TOOL_UNAVAILABLE' }
```

`failures` carries only what can be decided without looking at the file: `no-screens`, when
no photo has been chosen. Everything the planner can decide only after reading the source —
`nothing-to-remove`, an unsupported property — is answered by the run, on the row itself, as a
failed job with that code.

A row whose profile is no longer in memory — every persisted row after a restart — starts
anyway: the run's `inspecting` stage probes the file itself.

The run's stages are `inspecting → preparing → screens → joining → verifying`.

`StitchDestination` mirrors the compressor's three choices (FR-021):
`{ kind: 'beside' } | { kind: 'folder', path: string } | { kind: 'overwrite' }`. It is a
setting rather than a per-run argument, exactly as in the compressor. An `overwrite` replaces
the source only after a verified success; a failed run leaves the original untouched
(FR-021, SC-008).

## `POST /api/stitcher/jobs/:id/repeat`

Runs the same source again with a fresh draw from the library — the compressor's "repeat".

```
202 → StitcherState
404 → { error: 'STITCH_JOB_UNKNOWN' }
409 → { error: 'UPDATE_PENDING' }
```

## `DELETE /api/stitcher/jobs/:id` · `DELETE /api/stitcher/jobs/completed`

Forget one settled row, or every settled row. A run in flight is never removed from under
itself (`409 STITCH_JOB_RUNNING`).

## `POST /api/stitcher/jobs/:id/reveal` · `POST /api/stitcher/jobs/:id/open`

Show the finished file in the file manager, or open it. Before there is a result they point at
the source, exactly as the compressor's do.

## `POST /api/stitcher/jobs/:id/cancel`

```
200 → StitcherState
404 → { error: 'STITCH_JOB_UNKNOWN' }
409 → { error: 'STITCH_JOB_FINISHED' }
```

A row that is still waiting its turn is marked `cancelled` rather than returned to `ready` —
the compressor's rule, and what lets stop-all and the batch counters say what happened to it.
It carries no error: it reads as "not stitched yet".

Cancellation holds the live child and escalates SIGTERM → SIGKILL; partial output is removed
under the same `try/finally` that owns the temp directory (Principle IV).

## `POST /api/stitcher/settings`

POST rather than PATCH: the agent's CORS allowlist is GET/POST/DELETE/OPTIONS, so a PATCH
fails its preflight in the browser and the click does nothing.

Persisted screen and destination defaults, validated by the shared parser the way
`parseSettingsPatch` validates the compressor's.

```
body → Partial<StitchSettings>
200  → StitcherState
400  → { error: 'STITCH_SETTINGS_INVALID' }
```

## `GET /api/stitcher/events` (SSE)

Live job state, published on the shared `ChannelHub` under the channel name `stitcher` so a
client with the `event-stream` capability receives it on the single connection.

```
event: stitcher:state → { type: 'stitcher:state', state: StitcherState }
```

---

## Job failure codes

Reported on the job (`error`), not as an HTTP status, because they happen after 202:

| Code                         | Meaning                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `STITCH_SOURCE_UNSUPPORTED`  | Discovered at run time rather than at inspect time                                |
| `STITCH_VERIFICATION_FAILED` | The probe disagreed with the plan beyond tolerance (D7) — the output is discarded |
| `STITCH_OUTPUT_UNWRITABLE`   | Destination full, read-only, or vanished                                          |
| `STITCH_TOOL_FAILED`         | FFmpeg exited non-zero; the bounded stderr tail is logged, not sent               |
| `STITCH_CANCELLED`           | User cancellation                                                                 |

## Contract version

`AGENT_TOOL_CONTRACTS.stitcher = 1` and `WEB_TOOL_REQUIREMENTS.stitcher = { stitcher: 1,
imageEmbedding: 2 }` in `packages/shared/src/release.ts` — `imageEmbedding` because the
screens come from the compressor's image library. Adding the entry changes the map that
`scripts/verify-release.mjs:83` byte-compares against the signed `stable.json`, so the tool
ships together with an agent release (see plan.md, Principle II).
