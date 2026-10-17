-- Launch revisions retain their outputs even when the source is removed outside Soty.
create function private.launch_output_retained(p_team uuid,p_material uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.launch_output_is_referenced(p_team,p_material)
 or exists(select 1 from private.launch_restitch_preparations p join public.team_launch_generations g on g.id=p.generation_id
  join public.team_operations o on o.id=p.operation_id where g.team_id=p_team and o.result_material_id=p_material
   and g.state not in('cancel_requested','canceled_with_cleanup_pending','canceled','succeeded'))
 or exists(select 1 from private.catalog_generation_intents i join public.team_launch_generations g
  on i.request_key='launch:'||g.id::text||':catalog' and i.team_id=g.team_id
  where g.team_id=p_team and (i.checkpoint->>'materialId'=p_material::text or i.result->'catalog'->>'materialId'=p_material::text)
   and g.state not in('cancel_requested','canceled_with_cleanup_pending','canceled','succeeded'));
$$;
create function private.guard_launch_copy_retirement() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.role='retired' and private.launch_output_retained(new.team_id,new.material_id) then return null;end if;
 return new;
end $$;
create trigger team_catalog_copies_launch_retention before insert or update on public.team_catalog_restitch_copies
 for each row execute function private.guard_launch_copy_retirement();
revoke all on function private.launch_output_retained(uuid,uuid),private.guard_launch_copy_retirement() from public,anon,authenticated,service_role;
create or replace function public.service_claim_retired_restitch_copies(p_limit integer default 10)
returns table (material_id uuid, team_id uuid, drive_file_id text, credential_id uuid)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select copy.material_id
    from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
      and private.team_workspace_allowed(copy.team_id) -- 034
      and not private.launch_output_retained(copy.team_id,copy.material_id)
    order by copy.next_delete_at
    for update of copy skip locked
    limit least(greatest(p_limit, 1), 50)
  ), leased as (
    update public.team_catalog_restitch_copies as copy
       set next_delete_at = clock_timestamp() + interval '5 minutes',
           delete_attempts = copy.delete_attempts + 1
      from due
     where copy.material_id = due.material_id
    returning copy.material_id, copy.team_id, copy.drive_file_id
  )
  select leased.material_id, leased.team_id, leased.drive_file_id, connection.credential_id
  from leased
  join public.team_materials as file on file.id = leased.material_id
  join public.team_drive_connections as connection on connection.id = file.connection_id;
$$;

create or replace function public.service_claim_orphan_cleanups(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  material_id uuid,
  team_id uuid,
  drive_file_id text,
  resource_key text,
  credential_id uuid,
  companion_kind text,
  name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_orphan_cleanups();
  return query
  with due as (
    select item.material_id
    from private.orphan_cleanups as item
    where (item.lease_owner is null or item.lease_expires_at < clock_timestamp())
      and item.attempts < 5
      and private.team_workspace_allowed(item.team_id) -- 034
      and not private.launch_output_retained(item.team_id,item.material_id)
    order by item.queued_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), 50)
  ), leased as (
    update private.orphan_cleanups as item
       set lease_owner = p_worker,
           lease_expires_at = clock_timestamp()
             + make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
           attempts = item.attempts + 1
      from due
     where item.material_id = due.material_id
    returning item.material_id, item.team_id
  )
  select leased.material_id,
         leased.team_id,
         file.drive_file_id,
         file.resource_key,
         connection.credential_id,
         file.companion_kind,
         file.name
  from leased
  join public.team_materials as file on file.id = leased.material_id
  join public.team_drive_connections as connection on connection.id = file.connection_id;
end;
$$;
