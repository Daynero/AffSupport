# Data Model: Спільна галерея лендінгів командного простору

**Feature**: `004-team-landings-gallery` | **Date**: 2026-08-09

Scope: only the **new** state this feature adds and the **existing** state it reads. Existing
catalog/material/permission entities from 001 are reused unchanged and are referenced, not
redefined.

---

## 1. Reused entities (read-only here)

| Entity | Source | How this feature uses it |
| --- | --- | --- |
| **Material (catalog row)** | 001 catalog (`drive_vault_catalog` migration) | The gallery lists materials where `category = 'landing'`. Reads `id`, `name`, `category`, `classification_source` (`inspected_landing` vs candidate), `sourceVersion`, `fingerprint`, metadata (`geo`, `offer`, `language`, `tags`), `preview_state`, freshness. |
| **Effective permissions** | 001 `private.can(team, perm, uid)` | `view` gates gallery + preview; `download`/`edit` gate optional actions. Never widened client-side. |
| **Drive connection / root** | 001 drive connection | Source of truth for which landings exist; hidden `.soty/landing-previews/` subtree lives under this root. |
| **Preview grant / transfer** | 001 US4 `drive-transfer` `preview_range` grant | Reused to (a) range-download a landing zip for rendering and (b) stream a cached render's WebP bytes to an agent-less viewer. |
| **Viewer presets (local previewer)** | `LandingPreviewState` in `@video-compressor/shared` | Device size / colour scheme / zoom / grid preset model reused by the team viewer controls. |

---

## 2. New entity: `LandingRender` (DB table `landing_renders`)

A pointer to a produced, team-shared render of one landing at one source identity and one
viewer preset. **Small metadata only** — the image bytes are Drive files (§4).

| Field | Type | Rules |
| --- | --- | --- |
| `id` | uuid pk | server-generated |
| `team_id` | uuid fk → teams | RLS-scoped; every read predicate includes it |
| `material_id` | uuid fk → catalog material | the landing this render belongs to |
| `source_version` | text/int | must equal the material's current immutable `sourceVersion` to be **valid** |
| `fingerprint` | text | must equal the material's current `fingerprint` to be **valid** |
| `preset` | text enum | `default` (baseline); future device/colour presets keyed here |
| `segment_count` | int | number of WebP segments produced (≥1) |
| `artifact_root` | text | Drive path/id of `.soty/landing-previews/<materialId>/<source>-<fp>/<preset>/` |
| `render_state` | text enum | `rendering \| ready \| stale \| failed` |
| `failure_reason` | text enum null | `corrupt \| protected \| too_large \| unsupported \| render_error` (when `failed`) |
| `rendered_by` | uuid null | member whose agent produced it (audit; never exposed as content) |
| `created_at` / `updated_at` | timestamptz | audit |

**Uniqueness**: one **valid** render per (`team_id`, `material_id`, `preset`) at a given
(`source_version`, `fingerprint`). A new source identity supersedes rather than overwrites.

**Validity predicate** (single source of truth, mirrors `hasVersionedLandingProof`):
`render_state = 'ready' AND source_version = material.source_version AND fingerprint = material.fingerprint`.
Anything else ⇒ the landing is treated as **not rendered** for that preset.

**RLS / grants**: `revoke all`; `view`-callers may **read** their team's rows via a
`security definer` function; only the **service/scoped-grant** path may insert/commit/mark-stale.
No base-table client write.

### State transitions

```
(no row)
   │ member with compatible agent starts render
   ▼
rendering ──render ok──▶ ready ──source changes / tombstone──▶ stale ─┐
   │                       ▲                                          │
   │ render fails          │ re-render (agent)                        │ cleanup
   ▼                       └──────────────────────────────────────────┘
failed ──retry (agent)──▶ rendering                          (artifacts deleted; row prunable)
```

Reading `ready` with a matching source identity ⇒ browsable by **any** viewer without an agent.
Reading `stale`/`failed`/absent ⇒ tile shows `needs_agent` (if no compatible agent) or offers
render (if one is present).

---

## 3. New entity: `LandingGalleryItem` (derived, not stored)

The per-tile view model the web builds by joining a catalog landing row with its best
`LandingRender` and the current agent/permission context. Transport type in
`@video-compressor/shared/team`.

| Field | Derivation |
| --- | --- |
| `materialId`, `name`, `category`, metadata facets | from the catalog row |
| `isCandidate` | `classification_source != 'inspected_landing'` (archive not yet confirmed) |
| `thumbnailRef` | first WebP segment of the valid `ready` render (downscaled), else none |
| `renderState` | `ready \| candidate \| rendering \| needs_agent \| agent_outdated \| error` (see below) |
| `unavailableReason` | typed reason when `error` (`corrupt/protected/too_large/unsupported`) |
| `canDownload` / `canEdit` | from effective permissions (optional actions only) |

**`renderState` resolution (structural, guarantees SC-004 zero-false-ready):**

```
valid ready render exists?            → ready        (thumbnail fetchable by anyone, no agent)
else render_state = rendering?        → rendering
else classification = candidate?      → candidate    (promote on first successful render)
else compatible paired agent present? → (offer render; transient rendering on action)
else agent present but too old?       → agent_outdated
else render failed with reason?       → error(reason)
else                                  → needs_agent
```

---

## 4. New storage layout: Drive render artifacts (not a DB entity)

```
<connected root>/.soty/landing-previews/
  └── <materialId>/
        └── <sourceVersion>-<fingerprint>/
              └── <preset>/
                    ├── 0.webp   (full-page segment 0 — also the thumbnail source, downscaled)
                    ├── 1.webp
                    └── …        (segment_count files)
```

- Hidden `.soty/` namespace is **excluded** from the catalog classifier/listing (never appears
  as a material).
- Written service-side / via scoped grant with the shared account.
- Served to the browser as inert WebP through `drive-transfer` (no-store), never executed.
- Deleted with the source or on source change by the `catalog-sync` tombstone pass (§ research 6).

---

## 5. New client state: viewer presets & gallery view

| State | Where | Notes |
| --- | --- | --- |
| Active viewer preset (device / colour scheme / zoom / grid) | new `localStorage` key `soty.landing-viewer.v1` | reuses the local previewer preset shape; per-device, not synced |
| Gallery query (text + `category=landing` + facets + page) | `useTeamLandings` over `useCatalogSearch` | authoritative rows from the server; realtime refetch, no polling |
| Workspace view mode | existing `WorkspaceShell` `content \| search \| settings` | add a `landings` mode (FR-015) |

---

## 6. Validation rules (traceable to FRs)

- A tile MUST NOT render `ready` unless a valid `ready` render exists with matching source
  identity (FR-007, SC-004).
- A replaced landing's old render MUST become `stale` and MUST NOT be shown as current
  (FR-006, SC-007) — enforced by the validity predicate + tombstone cleanup.
- Reading a render pointer requires `view`; writing/committing requires the service/scoped-grant
  path (FR-010, Constitution III).
- Served render bytes are WebP images under `no-store`, in the sandbox’s inert content path;
  they never carry executable landing code (FR-011).
- Candidate archives (`classification_source != 'inspected_landing'`) appear as `candidate` and
  are promoted via the existing landing-promotion on first successful render (FR-013).
- Analytics records only opaque ids / counts / durations / states — never material name, Drive
  id, path, or content (FR-018).
