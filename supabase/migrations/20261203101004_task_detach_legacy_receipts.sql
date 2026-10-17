-- Older web clients still call the boolean RPC. Keep their wire contract but
-- route every detach through the same server deadline and intent ledger.
create or replace function public.detach_team_task_material(
  p_team uuid, p_task uuid, p_material uuid
)
returns boolean language sql security definer set search_path = '' as $$
  select (public.detach_team_task_material_v2(p_team,p_task,p_material)->>'detached')::boolean;
$$;
