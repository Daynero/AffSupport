# Contract: Agent — `/api/team/landings/*` (under the `teamWorkspace` tool contract)

New routes registered by the team-bridge `ToolModule` (`apps/agent/src/team-bridge/routes.ts`).
Follows Constitution IV/V: `spawn(..., { shell:false })` for Playwright, bounded output,
`mkdtemp` + `try/finally` cleanup, cancellation/watchdog holding the live child,
SIGTERM→SIGKILL; success returns a state snapshot, errors return `reply.code(N).send({ error })`
with a stable machine code. All routes require the `teamWorkspace` tool contract — an old agent
does not expose them and the web handshake yields `AGENT_UPDATE_REQUIRED`.

## `POST /api/team/landings/render`

Produce (or refresh) a shared render for one landing.

- **Body** (`unknown`, parsed/narrowed): `TeamLandingRenderRequest` (teamId, materialId,
  preset).
- **Flow** (reuses `previewLanding` machinery):
  1. Ask `drive-transfer` for a `preview_range` grant + an **artifact-write grant** (edge
     contract §2). 
  2. Range-download the landing zip, inspect (`inspectZip`), find the landing root
     `index.html`, extract to a `mkdtemp` dir.
  3. Render with the shared `LandingPageRenderer` (Playwright) at the requested preset →
     full-page WebP segments.
  4. Upload segments to the scoped `.soty/landing-previews/…` path via the artifact-write
     grant (bounded relay; `part.file.resume()`/`truncated` discipline).
  5. Call `service_commit_landing_render` (or `service_fail_landing_render` with a typed
     reason). Candidate archives are promoted via the existing preview-validation commit.
  6. `try/finally` remove the temp dir.
- **Responses**:
  - `200 { pointer: LandingRenderPointer }` (state `ready`), or
  - typed failure → `service_fail_landing_render` + `{ error: 'RENDER_FAILED', reason }`.
- **Errors / codes**: `AGENT_REQUIRED` is not applicable here (this *is* the agent), but the
  route returns `409 { error: 'RENDER_FAILED' }` with `reason ∈ corrupt|protected|too_large|
  unsupported|render_error`; `403 { error:'PERMISSION_DENIED' }`; `409 { error:'SOURCE_CHANGED' }`
  if the source identity moved mid-render (commit as stale, ask client to retry).
- **Cancellation**: `POST /api/team/landings/render/cancel` (or reuse the team SSE cancel)
  terminates the Playwright child and cleans up.

## `GET /api/team/landings/events` (SSE)

Per-render progress (`rendering` → `ready`/`failed`) on the guarded team SSE channel
(`apps/agent/src/team-bridge/events.ts`), so the gallery tile can show live state. Single
subscribe-and-reconnect path; per-client guard (no raw socket writes).

## Local-previewer interop (US3, P3)

Extend the local previewer catalog source (`apps/agent/src/landing-preview/catalog.ts` +
`scanner.ts`) with a **team-space source**: given a connected team + `view`, enumerate the
space's landings via the team catalog and render/serve them through the same team-bridge
range-download + `LandingPageRenderer`, so `LandingPreviewPage` can open a team space as a
catalog and show identical previews (FR-016). No new render engine; reuses this file’s
`/render` flow.

## Health / contract

`/api/health` advertises the bumped `teamWorkspace` tool contract version so
`toolContractCompatible('teamWorkspace', …)` gates the new routes. `real-agent-check.mjs`
extends to exercise render + cached-serve end to end.
