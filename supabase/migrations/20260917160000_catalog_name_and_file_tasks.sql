-- Feature 024 — a catalog's name before it is made, and the tasks a file is in.
--
-- The catalog form asked for a link and a count and said nothing about what it would make: the
-- name to use on Meta appeared only afterwards. `next_product_catalog_variant` gives the number
-- the next variation will take (the one the edge function uses), so the form can show
-- "IN 40_v2_catalog" with a copy button up front.
--
-- A file did not know which tasks it was on: "which launch used this creative?" meant opening
-- tasks one by one. `list_material_tasks` returns them for the details card.
--
-- Read-only, view permission. ROLLBACK.md drops both.

create or replace function public.next_product_catalog_variant(p_team uuid, p_video uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public.service_next_product_catalog_variant(p_team, p_video);
end;
$$;

revoke all on function public.next_product_catalog_variant(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.next_product_catalog_variant(uuid, uuid) to authenticated;

create or replace function public.list_material_tasks(p_team uuid, p_material uuid)
returns table (id uuid, title text, status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select task.id, task.title, task.status
  from public.team_task_attachments as attachment
  join public.team_tasks as task on task.id = attachment.task_id and task.team_id = attachment.team_id
  where attachment.team_id = p_team and attachment.material_id = p_material
  order by (task.status = 'done'), task.updated_at desc, task.id
  limit 20;
end;
$$;

revoke all on function public.list_material_tasks(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_material_tasks(uuid, uuid) to authenticated;
