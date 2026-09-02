# Contract: what the interface shows and where it lives

No new page. Three insertions into places that already exist.

---

## 1. A Re-stitching section in the space settings

`apps/web/src/team/workspace/SpaceSettings.tsx` already composes a grid of sections
(share preference, members, invitations). This adds one more, in the same shape.

The controls are **the stitcher's own**, reused rather than rebuilt: the operation picto row,
the two image galleries with their enable/disable behaviour, the fit-mode row, and the hold
duration ranges — the same components `ImageEmbeddingSection` and the stitcher page already
render. The section adds only what is genuinely new here:

- a state line — _not configured_ / a one-line summary of what is set (FR-004);
- **Prepare material**, with its progress and its result;
- the space's download folder, with a "change" action (research D7).

Read-only for a member without `manage_metadata`, with the reason shown rather than the
controls hidden (FR-003).

---

## 2. Download → original / re-stitched, on a video row

`apps/web/src/team/catalog/MaterialRowMenu.tsx` has a single `Download` action gated by
`permissions.download`. For a video it becomes a choice of two; for anything else it is
untouched (FR-007).

While a re-stitched delivery runs, the row shows its phase — the explorer already renders
per-row operation progress for processing, and this reuses it rather than inventing a second
indicator.

On success the file is saved and revealed, and the row keeps a _Save again_ affordance for the
rest of the session (FR-015).

---

## 3. The "not configured" toast

When re-stitched is chosen and `configured` is false:

- a toast: _"Re-stitching is not set up for this space"_ with a **Configure now** action
  (FR-011);
- the action opens the same settings section as a dialog over the current view — the space
  already has `SettingsDialog.tsx`, so this is a mount, not a navigation;
- saving there resumes the delivery that was asked for, without a second click;
- for a member who cannot change the space, the toast names who can instead of offering the
  action (FR-012).

---

## Shared types added to `@video-compressor/shared`

```
TeamRestitchDefaults        // the space's five settings + configured/updatedAt/updatedBy
MaterialRestitchPrep        // detected edges + source profile + driveVersion
TeamRestitchPrepareProgress // per-material progress on the prepare run
```

Each with a `{ ok: true; value } | { ok: false; error }` parse guard, because all three cross a
process boundary. No new bounds are introduced: the operation, fit mode and duration mode are
the existing unions, and the custom hold length reuses `clampStitchEndDuration`.

## Telemetry

Three typed events on the existing `analytics.track` union: the defaults saved, a preparation
run finished (with how many were prepared and how many refused), and a re-stitched delivery
finished (with its elapsed time and whether it used a prepared record). The last one is how
SC-001 is watched in the field rather than only in a test.
