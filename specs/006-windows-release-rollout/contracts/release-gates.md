# Contract: Release manifest and gates

**Files**: `apps/web/public/.well-known/wishly/stable.json`, `scripts/verify-release.mjs`,
`scripts/verify-published-release.mjs`, `scripts/sign-release-manifest.mjs`
**Origin of truth**: `packages/shared/src/release.ts` (Constitution II)
**Satisfies**: FR-022, FR-023, FR-024, FR-025, FR-028

## Manifest rule change

`StableReleaseManifest.artifacts` is `Partial<Record<ReleasePlatform, ReleaseArtifact>>` and stays
that way — the *schema* is unchanged (`schemaVersion` remains `1`). What changes is the release
rule:

> A stable release MUST list both `macos-arm64` and `windows-x64`, each with a URL equal to the
> corresponding constant in `release.ts` and a complete 64-hex `sha256`.

Path note: the manifest lives under `.well-known/wishly/`. `docs/WINDOWS.md` currently instructs
editing `.well-known/soty/stable.json`, which does not exist — following it edits nothing. Fixing
that doc is part of this feature.

## Gate changes

### `verify-release.mjs`

Today (`:89`) it requires only the macOS artifact and validates other platforms only if present
(`:93-99`). It gains a symmetric Windows requirement:

- `artifacts['windows-x64']` MUST exist and its `url` MUST equal `RELEASE_DOWNLOAD_URL_WINDOWS`.
- Failure message must name the platform and the specific defect (missing / wrong URL / bad
  checksum), following the existing `fail()` convention.

All existing checks are unchanged: version/build-id derivation, tool-requirement equality with
`WEB_TOOL_REQUIREMENTS`, localized summary bounds, https+sha256 for every listed artifact, and
manifest signature verification against `RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64`.

### `verify-published-release.mjs`

Today it HEADs `RELEASE_DOWNLOAD_URL` only. It must HEAD **both** platform URLs and fail naming
whichever is not published, so a manifest can never point at an artifact that is not actually
downloadable.

### `sign-release-manifest.mjs`

No change required — it already accepts `--platform windows-x64` and records the checksum before
re-signing. The Windows artifact's checksum is recorded through the same path as macOS.

## Consequence, stated plainly

Because `deploy:web` chains `verify-release --deploy` → `verify-published-release`, making the
Windows artifact mandatory means **a missing or broken Windows build blocks the macOS release and
the web deploy as well**. This is the maintainer's explicit decision (spec Assumptions), not an
accident of implementation.

## Verification

- Unit tests over the verifier logic: a manifest missing `windows-x64` fails; a Windows URL that
  does not match `RELEASE_DOWNLOAD_URL_WINDOWS` fails; a Windows artifact with a null or
  short sha256 fails; a complete two-platform manifest passes.
- The tests must build `packages/shared` first so they validate against current constants, never a
  stale `dist` (Constitution II).
