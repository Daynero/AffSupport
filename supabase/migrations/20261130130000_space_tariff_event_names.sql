-- The admin's tariff history reads as sentences: "issued Lead until …", "bound to the space
-- «…»". Events store codes and ids; the names are added when the history is read, so they are
-- the current names and the events already written read correctly too.

begin;

create function private.name_tariff_event_side(p_side jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when p_side is null or jsonb_typeof(p_side) <> 'object' then p_side
    else p_side
      || coalesce((
           select jsonb_build_object('planNameUk', plan.name_uk, 'planNameEn', plan.name_en)
           from public.tariff_plans as plan
           where plan.code = p_side ->> 'planCode'
         ), '{}'::jsonb)
      || coalesce((
           select jsonb_build_object('teamName', team.name)
           from public.teams as team
           where team.id::text = p_side ->> 'teamId'
         ), '{}'::jsonb)
  end;
$$;

revoke all on function private.name_tariff_event_side(jsonb) from public, anon, authenticated;

create or replace function public.admin_list_space_tariff_events(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  if p_id is null then
    -- The settings history has no tariff.
    return coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', event.id, 'tariffId', null, 'actorId', event.actor_id,
               'actorName', profile.display_name, 'kind', 'settings',
               'before', event.before, 'after', event.after,
               'createdAt', to_jsonb(event.created_at), 'undoable', false
             ) order by event.created_at desc, event.id desc)
      from public.tariff_settings_events as event
      left join public.profiles as profile on profile.id = event.actor_id
    ), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', event.id, 'tariffId', event.tariff_id, 'actorId', event.actor_id,
             'actorName', profile.display_name, 'kind', event.kind,
             'before', private.name_tariff_event_side(event.before),
             'after', private.name_tariff_event_side(event.after),
             'createdAt', to_jsonb(event.created_at),
             'undoable', private.space_tariff_event_undoable(event)
           ) order by event.created_at desc, event.id desc)
    from public.space_tariff_events as event
    left join public.profiles as profile on profile.id = event.actor_id
    where event.tariff_id = p_id
  ), '[]'::jsonb);
end;
$$;

commit;
