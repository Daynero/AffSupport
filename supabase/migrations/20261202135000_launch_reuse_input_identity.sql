-- Provenance lookup stays bounded as the workspace accumulates generations.
create index if not exists launch_restitch_operation_lookup
 on private.launch_restitch_preparations(team_id,operation_id) where operation_id is not null;

-- Active restitch inputs share one comparison in both video and catalog reuse.
-- Keep this projection in parity with launchRevisionImpact in shared/revisions.ts.
create or replace function private.launch_restitch_config_identity(p_catalog jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('on',p_catalog->'restitchEnabled') ||
  case when p_catalog->>'restitchEnabled'='true' then
   jsonb_build_object('mode',p_catalog->'finalDurationMode') ||
   case when p_catalog->>'finalDurationMode' in('custom','random-centered') then
    jsonb_build_object('seconds',p_catalog->'customFinalDurationSeconds') else '{}'::jsonb end ||
   case when p_catalog->>'finalDurationMode'='random-centered' then
    jsonb_build_object('range',p_catalog->'finalDurationRangeSeconds') else '{}'::jsonb end
  else '{}'::jsonb end;
$$;
revoke all on function private.launch_restitch_config_identity(jsonb) from public,anon,authenticated,service_role;

create or replace function private.launch_reusable_restitch(p_team uuid,p_generation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;b public.team_launch_revisions%rowtype;c public.team_launch_revision_catalogs%rowtype;m public.team_materials%rowtype;identity jsonb;
begin
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into b from public.team_launch_revisions where id=r.base_revision_id and team_id=p_team and launch_id=g.launch_id;
 select * into c from public.team_launch_revision_catalogs where revision_id=b.id and team_id=p_team;
 if c.restitch_material_id is null or r.config->'catalog'->>'restitchEnabled' is distinct from 'true'
  or b.config->'catalog'->>'restitchEnabled' is distinct from 'true'
  or r.config->>'materialId' is distinct from b.config->>'materialId'
  or private.launch_material_identity(r.sources) is null or private.launch_material_identity(r.sources) is distinct from private.launch_material_identity(b.sources)
  or r.sources->>'restitchSettingsVersion' is null or r.sources->>'restitchSettingsVersion' is distinct from b.sources->>'restitchSettingsVersion'
  or private.launch_restitch_config_identity(r.config->'catalog') is distinct from private.launch_restitch_config_identity(b.config->'catalog') then return null;end if;
 -- A prior buggy reuse could label an old video with a newer revision's duration.
 -- Prove inputs against the revision that actually prepared this child, not just its label.
 if not exists(select 1 from private.launch_restitch_preparations prep
  join public.team_launch_generations origin on origin.id=prep.generation_id and origin.team_id=prep.team_id
  join public.team_launch_revisions inputs on inputs.id=origin.revision_id and inputs.team_id=origin.team_id
  where prep.team_id=p_team and prep.operation_id=c.restitch_operation_id and origin.launch_id=g.launch_id
   and inputs.config->>'materialId'=r.config->>'materialId'
   and private.launch_material_identity(inputs.sources)=private.launch_material_identity(r.sources)
   and inputs.sources->>'restitchSettingsVersion'=r.sources->>'restitchSettingsVersion'
   and private.launch_restitch_config_identity(inputs.config->'catalog')=private.launch_restitch_config_identity(r.config->'catalog'))
 then return null;end if;
 select * into m from public.team_materials where team_id=p_team and id=c.restitch_material_id and lifecycle='active' and category='video';
 identity:=private.launch_material_identity(jsonb_build_object('materialChecksum',m.checksum,'materialDriveFileId',m.drive_file_id,'materialVersion',m.drive_version));
 if m.id is null or identity is null or c.settings_snapshot->'_launchRestitchIdentity' is distinct from identity
  or not exists(select 1 from public.team_operations o join private.team_operation_intents i on i.operation_id=o.id
   where o.id=c.restitch_operation_id and o.team_id=p_team and o.kind='process' and o.state='succeeded'
    and o.source_material_id=(r.config->>'materialId')::uuid and o.result_material_id=m.id and i.tool_id='restitch' and i.tool_contract_version=2)
  then return null;end if;
 return jsonb_build_object('operationId',c.restitch_operation_id,'materialId',m.id,'identity',identity);
end $$;

-- Names-only regeneration copies a validated historical catalog reference, never overwrites it.
create or replace function public.service_reuse_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns boolean language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;b public.team_launch_revisions%rowtype;c public.team_launch_revision_catalogs%rowtype;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into b from public.team_launch_revisions where id=r.base_revision_id and team_id=p_team;
 select * into c from public.team_launch_revision_catalogs where revision_id=b.id and team_id=p_team;
 if c.revision_id is null or r.config->>'method'<>'catalog' or b.config->>'method'<>'catalog' or r.generated_url is distinct from b.generated_url or r.config->>'materialId' is distinct from b.config->>'materialId' or r.config->'catalog'->>'productCount' is distinct from b.config->'catalog'->>'productCount' or private.launch_restitch_config_identity(r.config->'catalog') is distinct from private.launch_restitch_config_identity(b.config->'catalog') or private.launch_material_identity(r.sources) is null or private.launch_material_identity(r.sources) is distinct from private.launch_material_identity(b.sources) or r.sources->>'catalogSettingsVersion' is null or r.sources->>'catalogSettingsVersion' is distinct from b.sources->>'catalogSettingsVersion' or r.sources->>'restitchSettingsVersion' is distinct from b.sources->>'restitchSettingsVersion' then return false;end if;
 -- Catalog reuse must prove the actual video too, including historical reuse mistakes.
 if r.config->'catalog'->>'restitchEnabled'='true' and private.launch_reusable_restitch(p_team,p_generation) is null then return false;end if;
 if not exists(select 1 from public.team_product_catalogs p join public.team_materials m on m.id=p.material_id and m.team_id=p.team_id where p.team_id=p_team and p.material_id=c.material_id and p.source_link=r.generated_url and p.product_count=(r.config->'catalog'->>'productCount')::integer and p.sheet_url=c.sheet_url and m.lifecycle='active') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if c.restitch_material_id is not null and not exists(select 1 from public.team_materials where team_id=p_team and id=c.restitch_material_id and lifecycle='active') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into public.team_launch_revision_catalogs select team_id,r.id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=c.revision_id on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',result_material_id=c.material_id,reserved_variant=c.variant where generation_id=g.id and stage='catalog_registering';
 return true;
end $$;
revoke all on function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) to service_role;

-- Opaque receipt provenance lets inspect explain reuse without exposing configuration or media.
create or replace view public.analytics_launch_generations as
select g.id generation_id,g.team_id,g.launch_id,g.actor_id,g.revision_id,
 case when g.request_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then g.request_key else null end flow_id,
 g.state,case when g.stage in('accepted','preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','result_committed','cancel','cleanup') then g.stage else 'unknown' end stage,
 g.state_version::text,g.attempt_no,g.retryable,g.cancel_requested_at,g.created_at,g.updated_at,
 g.lease_expires_at,g.next_attempt_at,
 case when g.safe_error_code in('INVALID_INPUT','INVALID_RESPONSE','SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT','LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN','LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','AGENT_REQUIRED','NEEDS_REAUTH','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_CLIENT_OUTDATED','PROCESS_FAILED','PROCESS_CANCELED','WRONG_STATE','LAUNCH_INTERNAL_ERROR','SHARE_NOT_ALLOWED','NO_WORK') then g.safe_error_code when g.safe_error_code is not null then 'UNKNOWN' else null end safe_error_code,
 case when r.config->>'method'='catalog' then 'catalog' else 'other' end method,
 coalesce(l.active_revision_id=g.revision_id,false) result_is_active,
 exists(select 1 from public.team_launch_revision_catalogs c where c.revision_id=g.revision_id) catalog_registered,
 coalesce((select jsonb_agg(jsonb_build_object('stage',s.stage,'state',s.state,'child_operation_id',s.team_operation_id,'created_at',s.created_at,'updated_at',s.updated_at) order by s.created_at,s.id)
 from public.team_launch_generation_steps s where s.generation_id=g.id and s.stage in('preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','cleanup')),'[]'::jsonb) steps,
 jsonb_build_object(
  'video_operation_id',(select c.restitch_operation_id from public.team_launch_revision_catalogs c where c.revision_id=r.id and c.team_id=g.team_id),
  'video_generation_id',(select prep.generation_id from public.team_launch_revision_catalogs c
    join private.launch_restitch_preparations prep on prep.team_id=c.team_id and prep.operation_id=c.restitch_operation_id
    where c.revision_id=r.id and c.team_id=g.team_id limit 1),
  'catalog_revision_id',(select prior.revision_id from public.team_launch_revision_catalogs c
    join public.team_launch_revision_catalogs prior on prior.team_id=c.team_id and prior.material_id=c.material_id and prior.revision_id=r.base_revision_id
    where c.revision_id=r.id and c.team_id=g.team_id)
 ) reuse_evidence
from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id join public.team_launches l on l.id=g.launch_id and l.team_id=g.team_id;
