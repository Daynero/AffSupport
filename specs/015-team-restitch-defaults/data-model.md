# Phase 1 — Data model

Three stored things and two transient ones. Every stored shape follows the posture the
constitution requires of a new table: RLS on, `revoke all` then column-scoped grants, and
client access through `security definer` functions with `set search_path = ''`.

---

## 1. `public.team_restitch_defaults` — one answer per space

One row per team. Written by members with `manage_metadata`; readable by every member of the
team. Modelled on `public.team_share_preferences` (D4).

| Column                          | Type          | Notes                                                          |
| ------------------------------- | ------------- | -------------------------------------------------------------- |
| `team_id`                       | `uuid` PK     | → `public.teams(id)` on delete cascade                         |
| `operation`                     | `text`        | `restitch` \| `stitch` \| `unstitch`; checked                  |
| `start_image_ids`               | `uuid[]`      | may be empty when the operation needs no opening screen        |
| `end_image_ids`                 | `uuid[]`      | may be empty only for `unstitch`                               |
| `fit_mode`                      | `text`        | `cover` \| `contain` \| `stretch`; checked                     |
| `final_duration_mode`           | `text`        | `random-30-40` \| `random-40-50` \| `random-50-60` \| `custom` |
| `custom_final_duration_seconds` | `integer`     | only meaningful for `custom`; bounded by the shared clamp      |
| `configured`                    | `boolean`     | derived on write: false until a saveable set exists            |
| `updated_by`                    | `uuid`        | → `auth.users(id)`, for "who last changed it"                  |
| `created_at` / `updated_at`     | `timestamptz` |                                                                |

**Validation** (shared, not re-derived): the operation, fit mode and duration mode are the
existing string-literal unions; the custom length goes through `clampStitchEndDuration`; image
ids are checked to be uuids only — whether the acting agent _has_ that image is a run-time
question, not a storage one (D5).

**Rule**: saving is refused when the chosen operation needs a screen and no image id is given
for it (FR-005). This is one predicate, shared between the RPC and the UI.

**State**: `configured` is the only state, and it is a function of the row: a space either has
a saveable set or it does not. There is no draft.

---

## 2. `public.team_material_restitch_prep` — what was found in one material

One row per material that has been inspected. Written by the **web**, from what the agent
reported — the team bridge does not talk to Supabase and this feature does not change that.
Readable by every member.

| Column                   | Type          | Notes                                                                                               |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| `material_id`            | `uuid` PK     | → `public.team_materials(id)` on delete cascade                                                     |
| `team_id`                | `uuid`        | denormalised for RLS, as the sibling tables do                                                      |
| `drive_version`          | `text`        | the `driveVersion` this describes — the whole invalidation rule                                     |
| `detected_start_seconds` | `numeric`     | what the detector found at the head                                                                 |
| `detected_end_seconds`   | `numeric`     | …and at the tail                                                                                    |
| `source_profile`         | `jsonb`       | the probe result the cut needs: codec, size, frame rate, keyframes, audio                           |
| `unsupported_reason`     | `text` null   | set when the material cannot be served at all; the row still exists so the answer is not recomputed |
| `prepared_at`            | `timestamptz` |                                                                                                     |
| `prepared_by`            | `uuid`        | → `auth.users(id)`                                                                                  |

**Validation**: `source_profile` crosses a process boundary, so it is parsed with the shared
`parseSourceProfile` guard on the way in and on the way out — never cast.

**Lifecycle**

```
absent ──inspect──▶ prepared ──material content replaced──▶ absent
   ▲                    │
   └────────────────────┘  (drive_version mismatch is treated as absent)
```

A row whose `drive_version` differs from the material's current one is **ignored, not
deleted**, so a rollback to an earlier version finds its preparation again. A sweep removes
rows older than their material's history.

**Size**: a few hundred bytes per material. Fifty videos is well under a hundred kilobytes.

---

## 3. `public.team_workspace_folders` — the Soty folder on the drive

One row per team. Written when the folder is created or re-found.

| Column            | Type          | Notes                                                |
| ----------------- | ------------- | ---------------------------------------------------- |
| `team_id`         | `uuid` PK     | → `public.teams(id)` on delete cascade               |
| `drive_folder_id` | `text`        | the provider id, used first                          |
| `marker`          | `text`        | the `appProperties` value written on the folder (D3) |
| `created_at`      | `timestamptz` |                                                      |
| `verified_at`     | `timestamptz` | last time the id was proved to still be that folder  |

**Resolution order** (FR-017): cached `drive_folder_id` → search by `appProperties` marker →
create. A rename or a move changes neither the id nor the marker, so neither costs anything.

**Contents**: a `soty.json` describing the space's prepared state. Nothing else today — the
silence bank stays in the agent's own cache (D2/D3) — and the folder is deliberately open for
what later features put there.

---

## 4. Space re-stitch settings, in the shared contract (transient)

Not stored by this shape — it is what crosses the wire, in `@video-compressor/shared`:

```
TeamRestitchDefaults {
  operation: StitchOperation
  startImageIds: string[]
  endImageIds: string[]
  fitMode: ImageFitMode
  finalDurationMode: FinalImageDurationMode
  customFinalDurationSeconds: number
  configured: boolean
  updatedAt: string
  updatedBy: string | null
}
```

Every member type is an existing shared union. The parse guard returns
`{ ok: true; value } | { ok: false; error }` like the rest of the package.

---

## 5. A re-stitch delivery (transient, agent-side)

One running request. It is not stored — it lives as long as the operation, exactly like the
existing download bridge's entries, and is addressed by `operationId`.

```
requested ──▶ transferring ──▶ inspecting? ──▶ stitching ──▶ saving ──▶ delivered
     │              │               │              │            │
     └──────────────┴───────────────┴──────────────┴────────────┴──▶ failed | canceled
```

`inspecting` is skipped when a prepared record covers the material's current `drive_version` —
that skip is the whole feature. When it does run, its result is written back as a preparation
record (FR-023), so the next member does not pay for it.

**Progress**: reported per phase rather than as one percentage, because the phases have wildly
different lengths and a single bar would sit still through the transfer and then jump.

---

## Relationships

```
teams ─1:1─ team_restitch_defaults
teams ─1:1─ team_workspace_folders
teams ─1:N─ team_materials ─1:0..1─ team_material_restitch_prep
                                        (keyed also by drive_version)
```

Nothing here references the compressor's image library by foreign key: the images live on the
agent, and the space records only the ids it may draw from (D5).
