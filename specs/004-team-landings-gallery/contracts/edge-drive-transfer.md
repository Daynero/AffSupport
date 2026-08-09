# Contract: Edge — `drive-transfer` render serving + `catalog-sync` cleanup

Additive to existing Edge Functions. Envelope stays `{ ok:false, error:{ code, retryable,
details? } }`; success shapes follow the existing transfer/grant responses. Auth/gates reuse
`_shared/auth.ts`, `_shared/credentials.ts`, `_shared/drive.ts`, `_shared/operations.ts`.

## `drive-transfer` — new modes

### 1. Serve a cached render artifact to the browser (agent-less viewing)

- **Input**: an `artifactToken` (opaque, from the read path) identifying one render artifact
  segment; a bounded `Range` header.
- **Gate**: caller must have `view` on the team; the token is minted only for a **valid**
  `ready` render (source identity matches). No agent required.
- **Behaviour**: bounded, `no-store` Range forwarding of the WebP bytes from the hidden
  `.soty/landing-previews/…` Drive file — **reuses the exact US4 media byte path**. No whole
  file buffered in Edge; per-route `bodyLimit`.
- **Errors**: `PERMISSION_DENIED` (403), `NOT_FOUND`/`STALE_RENDER` (409) if the render is no
  longer valid (client falls back to `needs_agent`), `OAUTH_APPROVAL_REQUIRED` (gate closed).

### 2. Issue an artifact-write grant to a rendering agent

- **Input**: `teamId`, `materialId`, `preset`, current `sourceVersion`+`fingerprint`,
  `operationId`.
- **Gate**: caller has `view` (produce-render is allowed for viewers — it fills a shared cache,
  it does not mutate the source landing). The grant is **scoped** to write only under
  `.soty/landing-previews/<materialId>/<source>-<fp>/<preset>/` — never elsewhere in the root.
- **Output**: a scoped transfer grant (same hashing/consumption as US5 process-output upload)
  the agent uses to upload rendered WebP segments with the shared account. **No Google token or
  Vault reference is ever returned to the browser or the agent** — writes go through the
  audited service credential path.
- **Zero side effect on gate rejection** (no grant, no Drive write) — mirrors US4/US5.

## `catalog-sync` — render invalidation & cleanup

Extend the existing incremental change/tombstone pass:

- On a landing's source **change** (new `sourceVersion`/`fingerprint`) or **removal/trash**:
  call `service_mark_landing_renders_stale(team, material)` and delete the corresponding
  `.soty/landing-previews/<materialId>/<old-source>/` artifacts.
- The hidden `.soty/` subtree is **excluded** from classification/catalog ingestion (it must
  never appear as a material).
- Cleanup is idempotent and bounded like the rest of sync; failures are retried, not fatal.

## Compatibility

- New `drive-transfer` modes are gated behind the same production OAuth mode
  (`disabled|testing|verified`) and canonical-origin checks as 001. Nothing new is served in
  production until the provider gate is `verified`.
