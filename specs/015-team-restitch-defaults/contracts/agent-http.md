# Contract: Agent HTTP surface — re-stitched delivery and preparation

**Two ids, on purpose.** `stitcher` is the _tool contract_ — what `/api/health` advertises and
what `WEB_TOOL_REQUIREMENTS` checks. `restitch` is the _delegate_ — the local pipeline the
download bridge runs, alongside `compressor` and `imageEmbedding`. They are different layers
and neither name is a synonym for the other.

Two changes to the existing `team-bridge` module (`apps/agent/src/team-bridge/`) and no new
module. Both inherit the bridge's posture: origin allowlist, session token, entitlement gate,
`acceptingNewTasks()`, machine-code errors, and cancellation by `operationId`.

---

## `POST /api/team/download` — widened

The route already downloads a team file and can run a delegate on it before saving
(`compress?: { embed, suffix }`, added by 013). That optional field becomes a discriminated
one so a second tool can be asked for.

```
body → {
  operationId: string,
  transferUrl: string,
  transferGrant: TeamTransferGrant,
  fileName: string,
  destination?: string,                 // a folder already granted; omitted → ask once
  process?:
    | { tool: 'compressor'; embed: boolean; suffix: string }     // unchanged, 013
    | { tool: 'restitch'; defaults: TeamRestitchDefaults;
        prepared?: MaterialRestitchPrep }                        // new
}

200 → { saved: true, fileName: string, sizeBytes: number, elapsedMs: number }
400 → { error: 'INVALID_INPUT' }
403 → { error: 'PATH_NOT_GRANTED' }
409 → { error: 'UPDATE_PENDING' | 'WRONG_STATE' }
415 → { error: 'STITCH_SOURCE_UNSUPPORTED', reason: StitchUnsupportedReason }
503 → { error: 'MEDIA_TOOL_UNAVAILABLE' }
```

`compress` stays accepted as the old spelling for one release so a web build and an agent build
can differ by one step, as the tool-contract range already allows.

**With `prepared` present**, the run skips the probe and the detection entirely — that is the
whole of SC-001. **Without it**, the run inspects the source itself and returns what it found
so the caller can store it (below), which is FR-023.

```
200 → { …, discovered?: MaterialRestitchPrep }   // present only when it had to inspect
```

**Progress** is published on the bridge's existing event channel, per phase rather than as one
number: `transferring → inspecting → stitching → saving`.

**Cancellation**: `POST /api/team/download/:operationId/cancel`, unchanged.

**Destination**: the bridge asks the native picker when `destination` is absent. The web layer
sends the folder the space already chose, so the common path never opens a dialog (research
D7). A path that was never granted is refused rather than written to.

---

## `POST /api/team/restitch/prepare` — new

Inspects materials without producing anything. This is the button.

```
body → {
  operationId: string,
  teamId: string,
  transferUrl: string,
  materials: [{ materialId, driveVersion, fileName, transferGrant }],
  audio?: { sampleRate: number, channels: number }   // for the silence bank
}

202 → { accepted: true }
400 → { error: 'INVALID_INPUT' }
409 → { error: 'UPDATE_PENDING' }
503 → { error: 'MEDIA_TOOL_UNAVAILABLE' }
```

Runs one material at a time, honouring the power governor like every other local work.

**Progress** goes on the event channel as the same coarse `{state, stage, progress}` every
other team operation publishes. **What it found does not**: that channel is a broadcast and is
deliberately content-free, while a finding names a file and describes its shape. The findings
are read instead:

```
GET /api/team/restitch/prepare/:operationId
200 → { operationId, state: 'running' | 'finished' | 'canceled',
        done: number, total: number, current: string | null,
        findings: [{ materialId, state: 'inspecting' | 'prepared' | 'unsupported' | 'failed',
                     prep: MaterialRestitchPrep | null, reason: string | null }] }
404 → { error: 'NOT_FOUND' }
```

The last few finished runs stay readable, so a page that was reloaded mid-run still collects
what it missed.

The caller writes each `prep` through `set_material_restitch_prep`. The agent does not talk to
Supabase itself — the bridge never has, and it stays that way.

**The silence bank** is built once, before the first material, and is what makes the first
real delivery cheap (10.7–19 s saved, research D1).

**Cancellation**: `POST /api/team/restitch/prepare/:operationId/cancel` → `{ canceled: true }`
or `404 NOT_FOUND`. Whatever finished stays prepared (FR-020).

---

## Health and contracts

`toolContracts` already carries `stitcher` (feature 014). The web layer checks it with
`toolContractCompatible` before offering the re-stitched choice at all — the same gate the team
download and process paths already run — so an agent too old to stitch says so instead of
failing halfway.

**`WEB_TOOL_REQUIREMENTS` is not touched until release.** That map is compared byte-for-byte
with the signed `stable.json`, so adding an entry before the agent release ships makes
`verify-release.mjs` fail — the gate the constitution requires to pass before any deploy. The
live check above needs no map change, which is what lets the whole feature be developed with a
green gate.
