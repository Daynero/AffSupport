# Contracts: Спільна галерея лендінгів командного простору

These documents define the interface surface for `004-team-landings-gallery`. They describe
**contracts** (shapes, routes, RPC signatures, states, error codes), not implementations.

| File | Surface |
| --- | --- |
| [reused-surfaces.md](./reused-surfaces.md) | What is reused **unchanged** from 001 / 002 / the local previewer — do not re-spec. |
| [shared-landing-render.md](./shared-landing-render.md) | `@video-compressor/shared/team` transport + release/tool-contract additions. |
| [db-landing-renders.md](./db-landing-renders.md) | `landing_renders` migration + `security definer` RPC signatures + RLS/ACL. |
| [edge-drive-transfer.md](./edge-drive-transfer.md) | `drive-transfer` render-byte serving + artifact-write grant; `catalog-sync` cleanup. |
| [agent-team-landing-gallery.md](./agent-team-landing-gallery.md) | Agent `/api/team/landings/*` routes under the `teamWorkspace` tool contract. |
| [web-landings-gallery.md](./web-landings-gallery.md) | `teamApi`/client methods + gallery/full-view/viewer-controls UI contract. |

Conventions (from the constitution): machine-code errors (`AGENT_REQUIRED`,
`AGENT_UPDATE_REQUIRED`, `PERMISSION_DENIED`, `OAUTH_APPROVAL_REQUIRED`, …), not sentences;
Edge envelope `{ ok:false, error:{ code, retryable, details? } }`; agent success = tool state
snapshot, agent error = `reply.code(N).send({ error })`; SQL functions `security definer` +
`search_path=''` + fully-qualified + `revoke all` → narrow `grant`; the tree stays `any`-free.
