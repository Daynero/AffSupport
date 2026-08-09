# Contract: DB migration `20260810090000_team_landing_renders.sql`

Forward-only. Reverse steps recorded in `supabase/migrations/ROLLBACK.md`. Regenerate types
with `npm run types:supabase` into `apps/web/src/lib/database.types.ts`. All functions
`security definer`, `set search_path = ''`, fully-qualified objects, `revoke all` then narrow
`grant` (Constitution III). pgTAP in `supabase/tests/database/team-workspace.test.sql`.

## Table `public.landing_renders`

See data-model §2 for columns. Additional DB rules:

- RLS **enabled**; no blanket `using (true)`. Base table has `revoke all` from
  `anon, authenticated`; client access only through the definer functions below.
- Indexes: `(team_id, material_id, preset)` and a partial index on
  `(team_id, material_id) where render_state = 'ready'` for the gallery's valid-render join.
- FK `material_id` → catalog material with `on delete cascade`; FK `team_id` → teams.
- Realtime: publish only the columns needed for tile updates (state + source identity), never
  `artifact_root` raw path (served via token, not exposed).

## Read RPC (caller = `view`)

```
-- Returns valid render pointers for a set of landing materials in the caller's team.
-- Valid := render_state='ready' AND source_version=material.source_version
--          AND fingerprint=material.fingerprint.
private.can(p_team,'view',auth.uid())  -- required, else raise 'PERMISSION_DENIED'

function public.list_landing_renders(p_team uuid, p_material_ids uuid[], p_preset text)
  returns table(material_id uuid, state text, source_version text, fingerprint text,
                preset text, segment_count int, failure_reason text)
```

- `grant execute` to `authenticated` only; `revoke` from `anon`/publishable.
- Returns explicit columns (no `select *`); no `artifact_root` — the fetch token is minted by
  `drive-transfer` (see edge contract), not returned here.

## Write/commit RPCs (caller = service / scoped grant, NOT a user JWT)

```
function public.service_start_landing_render(p_team uuid, p_material uuid, p_preset text,
                                             p_source_version text, p_fingerprint text)
  returns uuid   -- render id; upserts a 'rendering' row for the current source identity

function public.service_commit_landing_render(p_render uuid, p_artifact_root text,
                                              p_segment_count int)
  returns void   -- 'rendering' -> 'ready'; validates source identity still current

function public.service_fail_landing_render(p_render uuid, p_reason text)
  returns void   -- 'rendering' -> 'failed'(reason)

function public.service_mark_landing_renders_stale(p_team uuid, p_material uuid)
  returns int    -- called by catalog-sync on source change/removal; -> 'stale', returns count
```

- `grant execute` to the **service/worker role only**; `revoke` from `authenticated`,
  `anon`, publishable.
- `service_commit_landing_render` MUST re-check that `p_source_version`/`p_fingerprint` still
  equal the material's current values; if not, commit as `stale` (never surface a stale render
  as ready) — enforces FR-006/SC-007 in the database.
- Landing-promotion of a candidate archive reuses the existing
  `service_commit_landing_preview_validation` path; `service_commit_landing_render` does not
  re-implement classification.

## Security assertions (pgTAP)

- Every function: `prosecdef = true`, empty `search_path`, exact EXECUTE ACL, fully-qualified.
- Read denied for non-member / non-`view` / foreign-team / spoofed uid.
- Write/commit/stale denied under a user JWT (service-only).
- Base-table RLS blocks direct client select/insert/update/delete.
- Committing with a mismatched source identity results in `stale`, not `ready`.
- Realtime publication exposes no raw artifact path.
