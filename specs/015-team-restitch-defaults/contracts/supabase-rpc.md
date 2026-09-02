# Contract: Supabase surface — space defaults, preparation, working folder

Three RPCs and one edge-function action. All follow the posture the constitution requires:
`security definer`, `set search_path = ''`, fully-qualified names, `revoke all` then narrow
grants to `authenticated`, and RLS on every new table. Modelled on the existing
`get_share_preference` / `set_share_preference` pair.

---

## `get_restitch_defaults(p_team_id uuid)`

Every member of the space may read.

```
returns → {
  operation, start_image_ids, end_image_ids, fit_mode,
  final_duration_mode, custom_final_duration_seconds,
  configured, updated_at, updated_by
} | null      -- null means never configured
```

`null` and `configured: false` are the same answer to the interface; the row simply may not
exist yet. The web layer narrows both into one "not configured" state so the toast in FR-011
has a single condition to branch on.

---

## `set_restitch_defaults(p_team_id uuid, p_defaults jsonb)`

Requires `manage_metadata` on the space. Refuses, with a code, a set that could not produce a
file.

```
returns → the stored row, as above
raises  → 'RESTITCH_FORBIDDEN'        caller may not change this space
          'RESTITCH_NO_SCREENS'       the operation needs a screen and no image was given
          'RESTITCH_INVALID'          a value outside its shared union or clamp
```

The three codes are machine codes, not sentences (Principle V); the web layer maps each to one
translated line.

**Bounds are not re-derived here.** The custom hold length is clamped by the same shared helper
the tools use; the SQL check exists to stop a direct call, not to define the rule.

---

## `get_material_restitch_prep(p_team_id uuid, p_material_ids uuid[])`

Every member may read. Returns one entry per material that has a preparation record whose
`drive_version` matches the material's current one; materials with no usable record are simply
absent from the result rather than returned as nulls.

```
returns → [{ material_id, detected_start_seconds, detected_end_seconds,
             source_profile, unsupported_reason, prepared_at }]
```

Batched on purpose: the explorer asks once per page of rows to show "prepared" on each,
not once per row.

---

## `set_material_restitch_prep(p_material_id uuid, p_drive_version text, p_prep jsonb)`

Requires `process` on the space — the same permission that lets a member run a tool at all.
Upserts on `material_id`. Writing a record for a `drive_version` that is no longer current
succeeds and is ignored on read, which is what makes a race between two members harmless.

```
returns → { stored: true }
raises  → 'RESTITCH_FORBIDDEN' | 'RESTITCH_INVALID'
```

---

## `drive-ops`: `ensure_workspace_folder`

A new action on the existing edge function, on the same authorization path as the rest
(`upload`, `rename`, `move`, `copy`, `trash`, `text edit`, `process`). There is no
folder-creating action today; this adds exactly one.

```
POST /drive-ops/ensure-workspace-folder
body  → { teamId }
200   → { folderId, created: boolean, name: string }
403   → { error: 'PERMISSION_DENIED' }   caller may not manage this space, or none is connected
503   → { error: 'DRIVE_UNAVAILABLE' }   the provider refused
```

**Behaviour**, in order (FR-016, FR-017):

1. If the space has a cached `drive_folder_id`, prove it still exists, is a folder, and still
   carries the marker. If so, return it with `created: false`.
2. Otherwise search the connected drive for a folder whose `appProperties` carry
   `soty.workspace = <team id>`. If found, cache and return it. `appProperties` are private to
   this application, so no other app's marks can collide with it.
3. Otherwise create `Soty` under the connection's root, set the marker, cache and return it
   with `created: true`.

Renaming or moving the folder changes neither its id nor its marker, so step 1 keeps working
and step 2 is the recovery when the id is stale. The name is never used to find it.
