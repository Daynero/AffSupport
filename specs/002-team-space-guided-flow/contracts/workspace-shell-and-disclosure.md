# Contract: Workspace Shell & Progressive Disclosure

Covers FR-014…FR-021, SC-004, SC-005, SC-006.

## Default (content-first) view (FR-014, FR-015, SC-004)

- The workspace shell's central, default element is the connected folder's contents
  (`MaterialBrowser`).
- By default the shell shows **no** filter controls and **no** management panels beside the
  content. The header carries only: the space name, **Change space**, **Space settings**, and
  (only when there is content) a **Search/filter** toggle.
- **Empty space invariant (SC-004)**: a freshly created, empty space renders zero filter
  controls and zero side management panels.

## Space settings surface (FR-016, FR-019, FR-020, SC-005)

- A single, clearly labelled **Space settings** entry opens a dedicated sub-view hosting the
  reused 001 components, unchanged: `MemberList`, `InvitationPanel`, `DriveConnectionPanel`
  (owner), `TeamAuditPanel` (owner/admin).
- Every 001 capability remains reachable in **≤ 2 actions** from the workspace (SC-005):
  open Space settings → the relevant panel.
- Each panel's visibility follows the existing permission gates; a user without a permission
  never sees the corresponding control (FR-020). No capability is removed — only relocated
  (FR-019).

## Progressive search & filters (FR-017)

- `TeamCatalog` does not render `CatalogSearchBar`/`CatalogFilters` on mount.
- Search is revealed via the header toggle. Filters render **only** when the catalog has ≥1
  material and the returned facet vocabulary is non-empty; an empty space shows neither.
- The underlying `useCatalogSearch` hook, `searchCatalog`, and `getCatalogVocabulary` calls are
  unchanged.

## Language, layout, accessibility (FR-018, FR-021)

- Plain, non-technical copy; predominantly one primary action per screen; no dense wall of
  simultaneous buttons/settings.
- Lobby, wizard, and shell remain readable and operable on narrow/zoomed viewports with no
  horizontal scroll of primary content; keyboard operable with visible focus and labelled
  controls; styled via `className` + `styles.css` custom properties (no inline static styles).

## Preview & processing (unchanged)

- Opening a material continues to use the existing `MaterialPreview` / processing components and
  their 001 backend calls; this feature does not alter preview or processing behaviour, only
  where their entry points sit within the decluttered shell.

## Acceptance mapping

- US3 scenarios 1–6: content-first (1), empty → zero filters (2), settings reachability (3),
  content-aware filters (4), simple one-action language (5), permission-gated visibility (6).
