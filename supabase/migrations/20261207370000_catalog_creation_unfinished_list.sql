-- 1.4.3: a catalog creation the person closed could not be found again.
-- A video's «Каталоги» window listed only finished catalogs and learned about a
-- running one from this browser's storage alone, so a creation started in
-- another browser, or whose key that storage had lost, was invisible: nothing
-- showed it, reopened its progress or canceled it (QA, beta: TR 7_v8, set
-- a0f1fd63, requeued and waiting with no window to run it).
--
-- This read lists the caller's own unfinished creations for one video with the
-- progress the window needs. Finished (registered), canceled and cleanup-only
-- intents are never listed, nor is one whose video set was already canceled.
-- The request key it returns is the one the existing read/resume/cancel
-- endpoints take, and they check the actor again.
begin;

create function public.list_my_unfinished_product_catalog_creations(p_team uuid,p_video uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(x.row order by x.created_at,x.id) from (
  select i.id,i.created_at,jsonb_build_object(
   'idempotencyKey',i.request_key,
   'variant',i.variant,
   'replacesMaterialId',i.replaces_material_id,
   'createdAt',i.created_at,
   'intentState',i.state,
   'safeErrorCode',i.safe_error_code,
   'sourceLink',i.request_payload->>'sourceLink',
   'productCount',case when jsonb_typeof(i.request_payload->'productCount')='number' then (i.request_payload->>'productCount')::integer end,
   'restitch',coalesce(i.request_payload->>'restitchEnabled','false')='true',
   'variationCount',case when jsonb_typeof(i.request_payload->'videoVariationCount')='number' then (i.request_payload->>'videoVariationCount')::integer end,
   'duration',case when jsonb_typeof(i.request_payload->'restitchDuration')='object' then i.request_payload->'restitchDuration' end,
   'copyVideoToR2',coalesce(i.request_payload->>'copyVideoToR2','false')='true',
   'setState',s.state,
   'requestedCount',s.requested_count,
   'registeredCount',coalesce(v.registered,0),
   'workingCount',coalesce(v.working,0),
   'queuedCount',coalesce(v.queued,0),
   'unknownCount',coalesce(v.unknown,0),
   'agentSilent',coalesce(v.silent,false)
  ) as row
  from private.catalog_generation_intents i
  left join private.catalog_video_sets s on s.catalog_intent_id=i.id and s.team_id=i.team_id
  left join lateral (
   select count(*) filter (where vv.state='registered') registered,
    count(*) filter (where vv.state='working') working,
    count(*) filter (where vv.state='queued') queued,
    count(*) filter (where vv.state='unknown') unknown,
    bool_or(vv.state='working' and vv.silence_observed_at is not null) silent
   from private.catalog_video_variants vv where vv.video_set_id=s.id
  ) v on s.id is not null
  where i.team_id=p_team and i.video_material_id=p_video and i.actor_id=auth.uid()
   and i.request_payload->>'catalogVideoProtocolVersion'='1'
   and i.request_key ~ '^product-catalog:[0-9a-f-]{36}$'
   and i.state not in('registered','canceled','cleanup_pending')
   and (s.id is null or s.state<>'canceled')
  order by i.created_at,i.id
  limit 10
 ) x),'[]'::jsonb);
end;$$;
revoke all on function public.list_my_unfinished_product_catalog_creations(uuid,uuid) from public,anon,service_role;
grant execute on function public.list_my_unfinished_product_catalog_creations(uuid,uuid) to authenticated;

commit;
