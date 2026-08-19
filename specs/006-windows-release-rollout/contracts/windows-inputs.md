# Contract: Windows build inputs

**File**: `packaging/windows/inputs.json`
**Produced by**: humans, once per bundled-binary change, alongside a `windows-inputs-<n>` mirror release
**Consumed by**: `scripts/fetch-windows-inputs.mjs` (CI), `THIRD_PARTY_NOTICES.md` generation
**Satisfies**: FR-027, FR-029, FR-030, FR-031

## Shape

```jsonc
{
  "schemaVersion": 1,
  "mirrorRelease": "windows-inputs-1",
  "inputs": [
    {
      "id": "ffmpeg",
      "mirrorUrl": "https://github.com/Daynero/AffSupport/releases/download/windows-inputs-1/ffmpeg-<ver>-win64-gpl.zip",
      "upstreamUrl": "https://…",
      "sha256": "<64 lowercase hex>",
      "sizeBytes": 123456789,
      "archiveKind": "zip",
      "memberPath": "bin/ffmpeg.exe",
      "stagesTo": "FFMPEG_BINARY_WIN",
      "license": "GPL-2.0-or-later",
      "provenance": "FFmpeg <exact version>, static win64 GPL build published by <publisher> on <date>",
      "sourceArchiveFor": null
    }
  ]
}
```

## Invariants

1. **Pinned, not floating.** `sha256` and `sizeBytes` are mandatory and exact. No `latest`, no
   version ranges, no redirect-following to an unpinned target.
2. **The build fetches only `mirrorUrl`.** `upstreamUrl` exists for attribution and for re-minting
   a future mirror; a release build that reaches upstream is a defect (upstream retention is not
   guaranteed — BtbN prunes, see research R2).
3. **Copyleft binaries carry their source.** Every input whose `license` is copyleft must have a
   companion input with `sourceArchiveFor` naming it. `fetch-windows-inputs.mjs` fails otherwise.
4. **Immutable history.** Entries are never edited in place. A new bundled binary means a new
   `windows-inputs-<n+1>` release and a new manifest revision, so any released commit still
   resolves to exactly the bytes it shipped with.
5. **`id` ↔ `stagesTo` is total.** Every environment variable
   `scripts/stage-windows-runtime.mjs` requires must be produced by exactly one input; an
   unmatched requirement fails the fetch, not the staging step.

## Failure behaviour

`fetch-windows-inputs.mjs` follows the repository's `.mjs` convention: a local `fail()` writing to
stderr and `process.exit(1)`, and a human confirmation line per verified input on success. Order of
checks per input — reachability → `sizeBytes` → `sha256` → archive member presence — so the cheapest
discriminating check runs first and every message names the offending `id`.

Parsing follows Constitution I: the JSON is read as `unknown` and narrowed by an explicit guard.
A malformed manifest fails with the field path, never a cast.

## Verification

- Unit test (runs on macOS): manifest parses, ids unique, every `stage-windows-runtime.mjs`
  requirement covered, every copyleft binary has a source archive, all hashes well-formed.
- CI: the fetch step itself is the integration test — a drifted mirror fails the release build.
