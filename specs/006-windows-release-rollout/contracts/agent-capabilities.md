# Contract: Agent platform capabilities

**Declared by**: `capabilities()` in `apps/agent/src/platform/platform.ts`
**Published in**: the `capabilities` array of `GET /health` and the pairing handshake
(`apps/agent/src/server/app.ts:181,196`)
**Consumed by**: agent route guards; the web app (`App.tsx:434`,
`TranscriptionPage.tsx:111`) and `normalizeToolContracts` in `packages/shared/src/release.ts`
**Satisfies**: FR-010, FR-014, FR-017, FR-018

## Change

`AGENT_CAPABILITIES` (`packages/shared/src/types.ts:483`) is a static `as const` array today, so
every agent advertises every capability — including `finder-image-conversion`, which only macOS can
serve. It becomes a **platform-derived list** computed from `capabilities()`.

The wire shape does not change: still `capabilities: string[]` in the same two payloads. The
`AGENT_CAPABILITIES` union remains the closed set of *possible* strings (so the web keeps
compile-time checking); what changes is that an agent advertises a subset.

## Capability set

| String | Meaning | macOS | Windows |
| --- | --- | --- | --- |
| `local-file-paths` | The agent can act on paths the browser hands it | yes | yes |
| `native-file-picker` | The agent can open an OS file/folder chooser | yes | yes |
| `finder-image-conversion` | OS file-manager context-menu image conversion | yes | **no** |
| `landing` | Landing optimizer available | yes | yes |
| `landing-preview` | Bundled browser can render previews | yes | yes |
| `transcription` | Transcription and translation available | yes | yes |
| `team-workspace` | Team workspace bridge available | yes | yes |

`native-file-picker` is new; it exposes the already-existing
`PlatformCapabilities.nativeFilePicker`, which is `true` on win32 today.

## Rules

1. **No platform names in tool code.** A route gates on a capability; `process.platform` appears
   only inside `apps/agent/src/platform/platform.ts`. Enforced by an ESLint
   `no-restricted-syntax` rule with a path override (research R7).
2. **Absent capability ⇒ `501` with a stable machine code**, per Constitution V. Existing
   behaviour is preserved: `/native/media-actions/images/convert` keeps refusing on Windows;
   `POST /api/files/select` **stops** refusing on Windows, because the capability is present
   (`apps/agent/src/compressor/routes.ts:48` is the defect this contract removes).
3. **Additive and backward compatible.** Older web clients ignore unknown strings; newer clients
   must treat an absent capability as "not offered", never as an error.
4. **One list, three consumers.** The advertised list, the route guards, and the web's feature
   gating all read the same source; adding a capability is a one-place change (FR-018).

## Verification

- Unit tests over `capabilities()` for `darwin` / `win32` / other, and over the derived advertised
  list for each platform.
- Route tests asserting `501` + machine code when a capability is absent, and success when present,
  with the platform stubbed rather than the OS.
- The Windows smoke run asserts the live `/health` list on Windows contains `native-file-picker`
  and does **not** contain `finder-image-conversion`.
