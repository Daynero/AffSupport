# Quickstart: validating the Windows Release Rollout

**Feature**: `specs/006-windows-release-rollout` | **Date**: 2026-08-19

How to prove this feature works, from a macOS workstation with no Windows machine. Scenarios are
ordered so each one is runnable as soon as its phase (see [plan.md](./plan.md)) lands.

## Prerequisites

- macOS workstation, Node 22, repository checked out, `npm ci` done.
- `gh` authenticated against `Daynero/AffSupport` (public repo; needed to read release assets and
  to trigger workflows).
- Shared is rebuilt before anything reads the release contract:
  `npm run build -w @video-compressor/shared`.
- No Windows machine, no code-signing certificate, no cloud VM required for scenarios 1–5.

---

## Scenario 1 — Inputs are pinned and reproducible (Phase A)

```sh
node scripts/fetch-windows-inputs.mjs --verify-only
```

**Expect**: one confirmation line per input naming its `id`, size and sha256; exit 0. Then prove
the gate bites:

```sh
# temporarily corrupt one sha256 in packaging/windows/inputs.json
node scripts/fetch-windows-inputs.mjs --verify-only   # expect: exit 1, message naming that input
```

Checksums can be confirmed without downloading, the same way research R4 pinned llama.cpp:

```sh
gh api repos/ggml-org/llama.cpp/releases/tags/b10092 \
  --jq '.assets[] | select(.name|test("win-cpu-x64")) | {name,size,digest}'
# expect digest sha256:c842fa7dc90e32b327c62903f4310ef251a902c90ef5b3a6c01c6b675dce078e, size 18021876
```

---

## Scenario 2 — Windows correctness, tested from macOS (Phase B)

```sh
npm run build -w @video-compressor/shared
npx vitest run tests/platform-capabilities.test.ts tests/agent-capabilities.test.ts \
  tests/files-picker.test.ts tests/translation-runtime-platforms.test.ts \
  tests/windows-inputs-manifest.test.ts
```

**Expect**:

- `capabilities()` returns `nativeFilePicker: true` on both `darwin` and `win32`, and
  `spotlightSearch: false` on win32.
- The advertised capability list contains `native-file-picker` on both platforms and
  `finder-image-conversion` on darwin **only**.
- `POST /api/files/select` succeeds with a stubbed win32 platform (this is the regression test for
  the `compressor/routes.ts:48` defect) and `/native/media-actions/images/convert` still returns
  `501` with its stable machine code.
- The `win32-x64` translation descriptor has a 64-hex sha256 and a positive `sizeBytes` — no
  `null`.

Then prove the "one place" rule is enforced:

```sh
npm run lint    # expect clean
# add `process.platform === 'win32'` to any file under apps/agent/src outside platform/
npm run lint    # expect a no-restricted-syntax error naming that file
```

---

## Scenario 3 — The installer builds itself in CI (Phase C)

```sh
gh workflow run release-windows.yml --ref beta
gh run watch
```

**Expect**: a green run on `windows-2022` producing a downloadable
`Soty-v<version>-Windows-x64.exe` artifact, with the version matching
`node scripts/release-meta.mjs product-version`. No step prompts for input, and nothing is uploaded
from your machine.

```sh
gh run download <run-id> --name windows-installer
shasum -a 256 Soty-v<version>-Windows-x64.exe
```

---

## Scenario 4 — The build verifies itself (Phase D)

Same workflow run; inspect the smoke stage.

**Expect** in the log: every required check from
[data-model.md](./data-model.md#5-windowsverificationrun) reported `passed`, an **empty** `skipped`
list, and the `unverifiedRisks` list echoed verbatim. Then prove the gate bites — re-run with a
deliberately broken payload (for example, omit the VAD model input) and expect the run to fail at
verification rather than to publish.

---

## Scenario 5 — Release gating (Phase E)

```sh
npm run build -w @video-compressor/shared
node scripts/verify-release.mjs
```

**Expect**, before the Windows artifact is recorded: `Release check failed:` naming the missing
`windows-x64` artifact. After recording it:

```sh
node scripts/sign-release-manifest.mjs --dmg <installer path> --platform windows-x64
node scripts/verify-release.mjs && node scripts/verify-published-release.mjs
```

**Expect**: both pass, and `verify-published-release` reports **two** verified URLs. Confirm the
consequence is real — remove the Windows artifact from `stable.json` and check that
`npm run deploy:web` refuses before reaching `wrangler`.

---

## Scenario 6 — The user-facing path (Phase F)

Local web check:

```sh
npm run dev -w @video-compressor/web
```

With a Windows user-agent (browser devtools device emulation), open the download dialog.

**Expect**: the Windows download offered first with a real URL; the unsigned-installer guidance
visible in both `en` and `uk`; and, with `windows-x64` removed from the manifest, the existing
waitlist dialog instead of a dead link.

---

## Scenario 7 — What a human still has to check (Phase F, once)

On a rented cloud Windows desktop or with a recruited waitlist tester, walk the four entries of the
[UnverifiedRisk](./data-model.md#6-unverifiedrisk) list: native chooser dialog (foreground,
multi-select, unicode paths), the SmartScreen unknown-publisher flow, antivirus behaviour on a
freshly published unsigned binary, and whether any firewall prompt appears for loopback listening.

**Expect**: each entry gains a `checkedBy` value in `docs/WINDOWS.md`. Until every entry is filled,
the download is not opened to all Windows visitors.

---

## Done when

Scenarios 1–6 pass from macOS alone, scenario 7 is recorded, and a Windows visitor to the
production site is offered the current release's Windows installer.
