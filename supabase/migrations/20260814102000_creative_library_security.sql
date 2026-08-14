-- Feature 005 least-privilege policies, exact function ACLs and safe Realtime columns.

create policy team_upload_batches_select_team
on public.team_upload_batches for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_upload_batch_items_select_team
on public.team_upload_batch_items for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_library_requirements_select_team
on public.team_library_requirements for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_library_results_select_team
on public.team_library_results for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_tasks_select_team
on public.team_tasks for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_task_attachments_select_team
on public.team_task_attachments for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_share_preferences_select_self
on public.team_share_preferences for select to authenticated
using (
  user_id = auth.uid()
  and private.can(team_id, 'view', auth.uid())
);

-- Direct writes stay revoked. Functions derive the caller from auth.uid() and re-check the
-- current effective permission. Restrict all matching feature functions first so a missed
-- signature can never retain PostgreSQL's default PUBLIC execute grant.
do $$
declare
  feature_function record;
begin
  for feature_function in
    select p.oid::regprocedure::text as signature
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public','private')
      and (
        p.proname like '%library%'
        or p.proname like '%team_task%'
        or p.proname like '%share_preference%'
      )
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.create_team_task(uuid, text, text, uuid, uuid)
to authenticated;
grant execute on function public.list_team_tasks(uuid, timestamptz, timestamptz, uuid, integer)
to authenticated;
grant execute on function public.get_team_task(uuid, uuid, bigint, integer)
to authenticated;
grant execute on function public.update_team_task(uuid, uuid, jsonb)
to authenticated;
grant execute on function public.attach_team_task_materials(uuid, uuid, uuid[])
to authenticated;
grant execute on function public.detach_team_task_material(uuid, uuid, uuid)
to authenticated;

grant execute on function public.scan_library_requirements(uuid, text, uuid)
to authenticated;
grant execute on function public.claim_library_job(uuid, uuid, text[], text, uuid)
to authenticated;
grant execute on function public.heartbeat_library_job(uuid, uuid, uuid, text, integer, text)
to authenticated;
grant execute on function public.cancel_library_job(uuid, uuid, uuid, text)
to authenticated;
grant execute on function public.fail_library_job(uuid, uuid, uuid, text, text)
to authenticated;
grant execute on function public.retry_failed_library_jobs(uuid, uuid)
to authenticated;
grant execute on function public.list_video_text_variants(uuid, uuid)
to authenticated;
grant execute on function public.get_library_processing_context(uuid, uuid)
to authenticated;
grant execute on function public.list_library_materials(uuid, text, uuid, integer)
to authenticated;
grant execute on function public.list_library_contribution_totals(uuid, timestamptz, timestamptz)
to authenticated;

grant execute on function public.get_share_preference(uuid) to authenticated;
grant execute on function public.set_share_preference(uuid, boolean) to authenticated;
grant execute on function public.reset_share_preference(uuid) to authenticated;

revoke all on function public.create_upload_batch(
  uuid, text, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.get_upload_batch(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.service_finalize_upload_batch_item(uuid, uuid, uuid, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.service_fail_upload_batch_item(uuid, uuid, uuid, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.service_enqueue_material_enrichments(uuid, uuid, text)
from public, anon, authenticated, service_role;
revoke all on function public.service_reserve_library_folder(uuid, uuid, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.service_get_library_connection_context(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.service_commit_library_folder(
  uuid, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.service_get_library_asset_placement(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.service_create_material_lifecycle_intent(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.service_create_material_group_intent(
  uuid, uuid, uuid, uuid, bigint, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.service_checkpoint_material_group_intent(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.service_mark_material_group_reconciling(uuid, text)
from public, anon, authenticated, service_role;
revoke all on function public.service_complete_material_group_intent(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.create_upload_batch(
  uuid, text, text, text, text, text, text, jsonb
) to authenticated;
grant execute on function public.get_upload_batch(uuid, uuid) to authenticated;
grant execute on function public.service_finalize_upload_batch_item(uuid, uuid, uuid, text, uuid)
to service_role;
grant execute on function public.service_fail_upload_batch_item(uuid, uuid, uuid, text, text)
to service_role;
grant execute on function public.service_enqueue_material_enrichments(uuid, uuid, text)
to service_role;
grant execute on function public.service_reserve_library_folder(uuid, uuid, text, text, text)
to service_role;
grant execute on function public.service_get_library_connection_context(uuid, uuid)
to service_role;
grant execute on function public.service_commit_library_folder(
  uuid, uuid, text, text, text, text, text
) to service_role;
grant execute on function public.service_get_library_asset_placement(uuid, uuid, uuid)
to service_role;
grant execute on function public.service_create_material_lifecycle_intent(
  uuid, uuid, uuid, uuid, text, text
) to service_role;
grant execute on function public.service_create_material_group_intent(
  uuid, uuid, uuid, uuid, bigint, uuid, text, text, text, text, text
) to service_role;
grant execute on function public.service_checkpoint_material_group_intent(uuid, uuid)
to service_role;
grant execute on function public.service_mark_material_group_reconciling(uuid, text)
to service_role;
grant execute on function public.service_complete_material_group_intent(uuid)
to service_role;

grant execute on function public.service_accept_library_result(
  uuid, uuid, uuid, uuid, text, uuid, text
) to service_role;
revoke all on function public.service_append_library_contribution(
  uuid, uuid, text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.service_append_library_contribution(
  uuid, uuid, text, text, text, uuid
) to service_role;

-- These projections contain no transcript body, provider id/URL, lease token, path, grant or
-- contribution detail. Rich content is fetched only through caller-checked RPCs.
grant select (
  id, team_id, state, total_items, succeeded_items, failed_items, updated_at, finished_at
) on table public.team_upload_batches to authenticated;
grant select (
  id, team_id, batch_id, state, progress, material_id, error_code, updated_at
) on table public.team_upload_batch_items to authenticated;
grant select (
  id, team_id, source_material_id, kind, variant, state, last_error_code, updated_at
) on table public.team_library_requirements to authenticated;
grant select (
  id, team_id, title, assignee_id, status, progress_max, progress_value,
  progress_manually_set, created_at, updated_at, completed_at
) on table public.team_tasks to authenticated;
grant select (
  id, team_id, task_id, material_id, position, attached_at
) on table public.team_task_attachments to authenticated;

alter publication supabase_realtime add table public.team_upload_batches (
  id, team_id, state, total_items, succeeded_items, failed_items, updated_at, finished_at
);
alter publication supabase_realtime add table public.team_upload_batch_items (
  id, team_id, batch_id, state, progress, material_id, error_code, updated_at
);
alter publication supabase_realtime add table public.team_library_requirements (
  id, team_id, source_material_id, kind, variant, state, last_error_code, updated_at
);
alter publication supabase_realtime add table public.team_tasks (
  id, team_id, title, assignee_id, status, progress_max, progress_value,
  progress_manually_set, created_at, updated_at, completed_at
);
alter publication supabase_realtime add table public.team_task_attachments (
  id, team_id, task_id, material_id, position, attached_at
);

comment on function public.list_video_text_variants(uuid, uuid) is
  'The sole Creative Library video-text body read; exact-team/current-version checked and never Realtime.';
comment on function public.attach_team_task_materials(uuid, uuid, uuid[]) is
  'Adds at most 100 stable catalog references per call, with no total task attachment cap or Drive mutation.';
