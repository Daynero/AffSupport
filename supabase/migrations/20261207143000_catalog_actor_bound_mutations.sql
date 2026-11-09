-- Preserve historical entry points for deployed clients; new UI binds its actor.
begin;
insert into public.team_error_codes(code) values ('CATALOG_STOP_TARGET_UNKNOWN') on conflict(code) do nothing;
create function public.patch_team_catalog_update_profile_as_actor(
  p_team uuid, p_catalog uuid, p_expected_version bigint, p_patch jsonb, p_expected_actor uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.patch_team_catalog_update_profile(p_team,p_catalog,p_expected_version,p_patch);
end $$;
revoke all on function public.patch_team_catalog_update_profile_as_actor(uuid,uuid,bigint,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function public.patch_team_catalog_update_profile_as_actor(uuid,uuid,bigint,jsonb,uuid)
  to authenticated;

create function public.cancel_team_catalog_update_attempt_as_actor(
  p_team uuid, p_catalog uuid, p_expected_round timestamptz,
  p_expected_attempt uuid, p_expected_actor uuid
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.cancel_team_catalog_update_attempt(p_team,p_catalog,p_expected_round,p_expected_attempt);
end $$;
revoke all on function public.cancel_team_catalog_update_attempt_as_actor(uuid,uuid,timestamptz,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.cancel_team_catalog_update_attempt_as_actor(uuid,uuid,timestamptz,uuid,uuid)
  to authenticated;


create function public.set_team_catalog_updater_restitch_as_actor(p_team uuid,p_restitch boolean,p_expected_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.set_team_catalog_updater_restitch(p_team,p_restitch);
end $$;
revoke all on function public.set_team_catalog_updater_restitch_as_actor(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.set_team_catalog_updater_restitch_as_actor(uuid,boolean,uuid) to authenticated;

create function public.set_team_catalog_updater_refresh_images_as_actor(p_team uuid,p_refresh boolean,p_expected_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.set_team_catalog_updater_refresh_images(p_team,p_refresh);
end $$;
revoke all on function public.set_team_catalog_updater_refresh_images_as_actor(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.set_team_catalog_updater_refresh_images_as_actor(uuid,boolean,uuid) to authenticated;

create function public.set_team_catalog_updater_refresh_texts_as_actor(p_team uuid,p_refresh boolean,p_expected_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.set_team_catalog_updater_refresh_texts(p_team,p_refresh);
end $$;
revoke all on function public.set_team_catalog_updater_refresh_texts_as_actor(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.set_team_catalog_updater_refresh_texts_as_actor(uuid,boolean,uuid) to authenticated;

create function public.set_team_catalog_updater_random_link_variation_as_actor(p_team uuid,p_enabled boolean,p_expected_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.set_team_catalog_updater_random_link_variation(p_team,p_enabled);
end $$;
revoke all on function public.set_team_catalog_updater_random_link_variation_as_actor(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.set_team_catalog_updater_random_link_variation_as_actor(uuid,boolean,uuid) to authenticated;

create function public.set_team_catalog_updater_grow_as_actor(p_team uuid,p_grow boolean,p_expected_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.set_team_catalog_updater_grow(p_team,p_grow);
end $$;
revoke all on function public.set_team_catalog_updater_grow_as_actor(uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.set_team_catalog_updater_grow_as_actor(uuid,boolean,uuid) to authenticated;

notify pgrst,'reload schema';
commit;
