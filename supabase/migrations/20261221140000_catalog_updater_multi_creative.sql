-- 062: the catalog manager and updater for catalogs with several creatives.
--
-- Owner's table (research R27/R34/R35):
--   one video      - everything as before;
--   several videos - restitch, R2 and text refresh stay; random link
--                    variation, image refresh, growth, video replacement and
--                    the link check are refused with MULTI_CREATIVE_UNSUPPORTED;
--   images         - R2 and text refresh stay; restitch is refused as well.
-- This migration:
--   * list_team_catalog_update_profiles returns creative_kind and
--     creatives [{alias, kind}] so the manager shows the list and its icons;
--   * a new profile of such a catalog starts with the hidden switches off,
--     and patch_team_catalog_update_profile refuses to turn them on;
--   * video replacement and the link check refuse such catalogs;
--   * the video R2 cell sources of a 'creatives' target are its video
--     segments; image segments are never video R2 sources;
--   * set_catalog_creative_image_r2 switches the R2 link of an image catalog
--     and asks for an immediate publication of column H.
begin;

create function private.patch_function_062(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function; end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_062_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062(regprocedure, text, text) from public, anon, authenticated, service_role;

-- Profile list: + creative_kind ('video' | 'image' | null for catalogs from before 062) and creatives.
-- The return type grows, so the function is dropped and created again; the body is the
-- previous live one with the two columns added at the end (as the anchored patch made it).
drop function public.list_team_catalog_update_profiles(uuid);
create function public.list_team_catalog_update_profiles(p_team uuid)
 RETURNS TABLE(catalog_material_id uuid, refresh_images boolean, refresh_texts boolean, grow_products boolean, random_link_variation boolean, restitch boolean, version bigint, updated_at timestamp with time zone, last_error_at timestamp with time zone, restitch_status text, restitch_blocked_code text, reconciliation_required boolean, last_result text, latest_attempt_at timestamp with time zone, last_successful_at timestamp with time zone, schedule jsonb, video_variant_count integer, creative_kind text, creatives jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select profile.catalog_material_id, profile.refresh_images, profile.refresh_texts,
           profile.grow_products, profile.random_link_variation, profile.restitch,
           profile.version, profile.updated_at, catalog.last_update_error_at,
           case when private.catalog_has_usable_spare(profile.catalog_material_id) then 'ready'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and private.catalog_restitch_visible_error(profile.catalog_material_id) is not null
           ) then 'blocked'
           else 'waiting' end,
           private.catalog_restitch_visible_error(profile.catalog_material_id), (coalesce(item.reconciliation_required, false) or exists (
             select 1 from private.catalog_update_reconciliations pending
             where pending.catalog_material_id=profile.catalog_material_id)),
           latest.result, latest.started_at,
           (select max(attempt.delivery_verified_at)
              from public.team_catalog_update_attempts as attempt
             where attempt.catalog_material_id = profile.catalog_material_id
               and attempt.team_id = p_team
               and attempt.result = 'success'
               and attempt.delivery_verified_at is not null), profile.schedule,profile.video_variant_count,
           case when catalog.settings_snapshot->>'_catalogCreativeKind' in ('video','image') then catalog.settings_snapshot->>'_catalogCreativeKind' end,
           case when jsonb_typeof(catalog.settings_snapshot->'_catalogCreatives') = 'array' then
             (select coalesce(jsonb_agg(jsonb_build_object('alias', c.value->'alias', 'kind', c.value->'kind') order by c.ordinality), '[]'::jsonb)
                from jsonb_array_elements(catalog.settings_snapshot->'_catalogCreatives') with ordinality c) end
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    left join lateral (
      select attempt.result, attempt.started_at
        from public.team_catalog_update_attempts as attempt
       where attempt.catalog_material_id = profile.catalog_material_id
         and attempt.team_id = p_team
       order by attempt.started_at desc, attempt.attempt_id desc
       limit 1
    ) as latest on true
    where profile.team_id = p_team;
end;
$function$;
revoke all on function public.list_team_catalog_update_profiles(uuid) from public, anon;
grant execute on function public.list_team_catalog_update_profiles(uuid) to authenticated, service_role;

-- A new profile of a catalog with several creatives starts with the hidden switches off.
select private.patch_function_062('private.seed_catalog_update_profile()'::regprocedure,
  $find$         coalesce(updater.refresh_images, true),
         coalesce(updater.refresh_texts, true),
         coalesce(updater.grow_products, false),
         coalesce(updater.random_link_variation,
                  new.settings_snapshot -> 'randomLinkVariation' <> 'false'::jsonb, true),
         coalesce(updater.default_restitch, false)$find$,
  $repl$         coalesce(updater.refresh_images, true) and private.catalog_multi_creative_kind(new.material_id) is null,
         coalesce(updater.refresh_texts, true),
         coalesce(updater.grow_products, false) and private.catalog_multi_creative_kind(new.material_id) is null,
         coalesce(updater.random_link_variation,
                  new.settings_snapshot -> 'randomLinkVariation' <> 'false'::jsonb, true) and private.catalog_multi_creative_kind(new.material_id) is null,
         coalesce(updater.default_restitch, false) and private.catalog_multi_creative_kind(new.material_id) is distinct from 'image'$repl$);

-- The profile patch refuses the hidden switches, and keeps one variation per video.
select private.patch_function_062('public.patch_team_catalog_update_profile(uuid,uuid,bigint,jsonb)'::regprocedure,
  $find$  if changed.version is distinct from p_expected_version then raise exception 'STALE_RESULT' using errcode = 'PT409'; end if;$find$,
  $repl$  if changed.version is distinct from p_expected_version then raise exception 'STALE_RESULT' using errcode = 'PT409'; end if;
  if private.catalog_multi_creative_kind(p_catalog) is not null and (
       p_patch->'randomLinkVariation' = 'true'::jsonb or p_patch->'refreshImages' = 'true'::jsonb or p_patch->'growProducts' = 'true'::jsonb
    or (private.catalog_multi_creative_kind(p_catalog) = 'image' and (p_patch->'restitch' = 'true'::jsonb or p_patch ? 'videoVariantCount'))) then
    raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode = '22023';
  end if;
  if private.catalog_multi_creative_kind(p_catalog) = 'videos' and p_patch ? 'videoVariantCount'
     and (p_patch->>'videoVariantCount')::numeric < (select jsonb_array_length(c.settings_snapshot->'_catalogCreatives') from public.team_product_catalogs c where c.material_id = p_catalog) then
    raise exception 'VARIATIONS_RANGE' using errcode = '22023';
  end if;$repl$);

-- Video replacement and the link check are not offered for such catalogs.
alter function public.service_accept_catalog_video_replacement(uuid, uuid, uuid, jsonb) rename to service_accept_catalog_video_replacement_before_062;
revoke all on function public.service_accept_catalog_video_replacement_before_062(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
create function public.service_accept_catalog_video_replacement(p_team uuid, p_catalog uuid, p_actor uuid, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if private.catalog_multi_creative_kind(p_catalog) is not null then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode = '22023'; end if;
  return public.service_accept_catalog_video_replacement_before_062(p_team, p_catalog, p_actor, p_request);
end $$;
revoke all on function public.service_accept_catalog_video_replacement(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.service_accept_catalog_video_replacement(uuid, uuid, uuid, jsonb) to service_role;

alter function public.service_begin_catalog_baseline_check(uuid, uuid, uuid, uuid, bigint) rename to service_begin_catalog_baseline_check_before_062;
revoke all on function public.service_begin_catalog_baseline_check_before_062(uuid, uuid, uuid, uuid, bigint) from public, anon, authenticated, service_role;
create function public.service_begin_catalog_baseline_check(p_check uuid, p_team uuid, p_actor uuid, p_catalog uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if private.catalog_multi_creative_kind(p_catalog) is not null then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode = '22023'; end if;
  return public.service_begin_catalog_baseline_check_before_062(p_check, p_team, p_actor, p_catalog, p_expected_revision);
end $$;
revoke all on function public.service_begin_catalog_baseline_check(uuid, uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.service_begin_catalog_baseline_check(uuid, uuid, uuid, uuid, bigint) to service_role;

-- Video R2: the video segments of a 'creatives' target; never an image segment.
create or replace function private.catalog_video_r2_cell_sources(p_job uuid)
returns table(material_id uuid, source_version text, link_kind text) language sql stable security definer set search_path = '' as $$
 select rc.material_id, rc.source_version, coalesce(rc.link_kind,'drive')
 from private.catalog_publication_link_receipts rc where rc.job_id=p_job
  and not exists(select 1 from private.catalog_video_publication_jobs j join private.catalog_publication_target_segments g on g.target_id=j.target_id
                  where j.id=p_job and g.kind='image' and g.source_material_id=rc.material_id)
 union all
 select t.source_material_id, t.source_version, 'drive'
 from private.catalog_video_publication_jobs j
 join private.catalog_publication_targets t on t.id=j.target_id and t.team_id=j.team_id
 where j.id=p_job and t.kind='source' and t.source_material_id is not null
  and not exists(select 1 from private.catalog_publication_link_receipts rc where rc.job_id=p_job)
 union all
 select distinct v.output_material_id, private.catalog_publication_source_version(v.output_material_id,j.team_id), 'drive'
 from private.catalog_video_publication_jobs j
 join private.catalog_publication_targets t on t.id=j.target_id and t.team_id=j.team_id
 join private.catalog_video_variants v on v.video_set_id=t.video_set_id and v.state='registered' and v.output_material_id is not null
 where j.id=p_job and t.kind='video_set'
  and not exists(select 1 from private.catalog_publication_link_receipts rc where rc.job_id=p_job)
 union all
 select g.source_material_id, g.source_version, 'drive'
 from private.catalog_video_publication_jobs j
 join private.catalog_publication_target_segments g on g.target_id=j.target_id and g.team_id=j.team_id
 where j.id=p_job and g.kind='video' and g.video_set_id is null
  and not exists(select 1 from private.catalog_publication_link_receipts rc where rc.job_id=p_job)
 union all
 select distinct v.output_material_id, private.catalog_publication_source_version(v.output_material_id,j.team_id), 'drive'
 from private.catalog_video_publication_jobs j
 join private.catalog_publication_target_segments g on g.target_id=j.target_id and g.team_id=j.team_id
 join private.catalog_video_variants v on v.video_set_id=g.video_set_id and v.state='registered' and v.output_material_id is not null
 where j.id=p_job and g.kind='video' and g.video_set_id is not null
  and not exists(select 1 from private.catalog_publication_link_receipts rc where rc.job_id=p_job)
$$;

-- R2 link of an image catalog: the choice is stored and column H is published at once.
-- Image R2 does not depend on the video R2 configuration: the image bucket is shared and live.
-- Returns {enabled, revision, updatedAt, publication: <publication receipt> | null}.
create function public.set_catalog_creative_image_r2(p_catalog uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.team_materials%rowtype; pref private.catalog_video_r2_preferences%rowtype;
  p private.catalog_video_publication_policies%rowtype; receipt jsonb; actor uuid := auth.uid();
begin
  if actor is null or p_catalog is null or p_enabled is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select * into m from public.team_materials where id = p_catalog and lifecycle = 'active' for update;
  if m.id is null or not exists (select 1 from public.team_product_catalogs where material_id = p_catalog) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not private.can(m.team_id, 'manage_metadata', actor) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  if private.catalog_multi_creative_kind(p_catalog) is distinct from 'image' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  insert into private.catalog_video_r2_preferences(catalog_material_id, team_id, enabled, configured_by) values (p_catalog, m.team_id, p_enabled, actor)
  on conflict (catalog_material_id) do update set enabled = excluded.enabled, revision = private.catalog_video_r2_preferences.revision + 1,
    configured_by = excluded.configured_by, updated_at = clock_timestamp()
  returning * into pref;
  select * into p from private.catalog_video_publication_policies where catalog_material_id = p_catalog for update;
  -- A schedule still ahead publishes the new kind of link when it comes due.
  if p.catalog_material_id is not null and not (p.mode = 'scheduled' and p.due_at > clock_timestamp()) then
    receipt := public.service_save_catalog_publication(m.team_id, actor, gen_random_uuid(), p_catalog, p.revision, 'immediate', null, null,
      private.catalog_publication_target_json(p.target_id));
  end if;
  return jsonb_build_object('enabled', pref.enabled, 'revision', pref.revision, 'updatedAt', pref.updated_at, 'publication', receipt);
end $$;
revoke all on function public.set_catalog_creative_image_r2(uuid, boolean) from public, anon;
grant execute on function public.set_catalog_creative_image_r2(uuid, boolean) to authenticated, service_role;

drop function private.patch_function_062(regprocedure, text, text);

commit;
