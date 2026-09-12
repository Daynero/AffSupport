-- Nine functions were executable by PUBLIC. None of them meant to be.
--
-- PostgreSQL grants EXECUTE to PUBLIC by default, so a function is open unless a
-- migration closes it. Every caller-facing RPC in this project revokes and then
-- grants — that is the pattern — and eight functions across five migrations
-- simply never got the revoke. Nothing here was exploitable through the product:
-- PostgREST exposes `public` only, and the `public` ones check `auth.uid()` and
-- touch the caller's own row. But "not reachable today" was resting on a gateway
-- setting rather than on a grant, which is exactly what the database tests
-- assert against, and they have been failing about it for some time.
--
-- The private helpers are the sharper half. `authenticated` holds USAGE on the
-- `private` schema, and `private.team_material_selection_for` is SECURITY
-- DEFINER with no membership check — by design, because its callers check first.
-- Reachable directly, it would answer questions about a team the caller is not
-- in. It is not reachable directly. It should also not be granted as if it were.
--
-- Deliberately untouched: `public.analytics_properties_are_safe_v2(jsonb)`. It
-- backs a CHECK constraint on `analytics_events`, which is evaluated for every
-- inserting role; revoking it buys nothing and risks the one thing in this file
-- that could break a write path.
--
-- Backwards compatible with the released client: every caller that could reach
-- these before is `authenticated`, and every caller-facing function keeps an
-- explicit grant to `authenticated`. Forward-only; reverse steps in ROLLBACK.md.

-- Internal helpers: called from inside SECURITY DEFINER functions, trigger
-- bodies and index expressions, all of which run as the owner and are unaffected
-- by a PUBLIC revoke.
revoke all on function private.team_material_assign_selection() from public;
revoke all on function private.team_material_selection_for(uuid, uuid, text) from public;
revoke all on function private.team_material_thumbnail_state() from public;
revoke all on function private.team_sync_root_selection() from public;
revoke all on function private.team_task_sort_at(date, timestamptz) from public;

-- Caller-facing RPCs: closed to PUBLIC, opened to the role that was always
-- meant to hold them. `list_video_text_variants` already had its grant from
-- 20260814102000 and only ever lacked the revoke.
revoke all on function public.get_task_progress_max_default() from public;
grant execute on function public.get_task_progress_max_default() to authenticated;

revoke all on function public.set_task_progress_max_default(integer) from public;
grant execute on function public.set_task_progress_max_default(integer) to authenticated;

revoke all on function public.list_video_text_variants(uuid, uuid) from public;
grant execute on function public.list_video_text_variants(uuid, uuid) to authenticated;
