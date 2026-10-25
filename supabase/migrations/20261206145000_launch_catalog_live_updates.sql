-- Launch revisions preserve the generated configuration and file identity. The
-- referenced spreadsheet remains a working catalog: explicit manual updates and
-- user-enabled schedules rewrite that same file through the fenced updater.
begin;

create or replace function private.guard_launch_catalog_updater()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.team_materials where id = new.catalog_material_id for update;
  -- A new Launch candidate may inherit workspace scheduling during registration.
  -- Keep it out of the queue until its initial generation is settled. Never
  -- freeze a published catalog merely because a historical revision references it.
  if exists (
    select 1 from private.catalog_generation_intents i
    join public.team_launch_generations g
      on i.request_key = 'launch:' || g.id::text || ':catalog'
      and i.team_id = g.team_id and i.actor_id = g.actor_id
    where i.checkpoint ->> 'materialId' = new.catalog_material_id::text
      and g.state not in ('succeeded', 'canceled')
  ) then
    new.update_interval := null;
    new.next_run_at := null;
    new.round_due_at := null;
    new.lease_expires_at := null;
  end if;
  return new;
end $$;

create or replace function private.guard_launch_catalog_reference()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.team_materials
    where team_id = new.team_id and id in (new.material_id, new.restitch_material_id)
    order by id for update;
  -- Reusing the same catalog is valid while its schedule or updater is active.
  -- Destructive operations still conflict with attaching an enduring reference.
  if exists (
    select 1 from public.team_operations
    where team_id = new.team_id
      and source_material_id in (new.material_id, new.restitch_material_id)
      and kind in ('rename', 'move', 'content_edit', 'new_version', 'trash')
      and state in ('pending', 'running')
  ) then
    raise exception 'LAUNCH_BUSY' using errcode = '55000';
  end if;
  return new;
end $$;

revoke all on function private.guard_launch_catalog_updater(),
  private.guard_launch_catalog_reference() from public, anon, authenticated, service_role;
-- Product growth is an intentional updater operation. Reuse still checks the
-- requested count against the prior Launch configuration above; the live count
-- may already be larger. File identity, source URL and source provenance remain
-- mandatory, while the original settings snapshot is copied unchanged.
create or replace function public.service_reuse_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns boolean language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;b public.team_launch_revisions%rowtype;c public.team_launch_revision_catalogs%rowtype;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'preparing');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into b from public.team_launch_revisions where id=r.base_revision_id and team_id=p_team;
 select * into c from public.team_launch_revision_catalogs where revision_id=b.id and team_id=p_team;
 if c.revision_id is null
  or r.config->>'method'<>'catalog'
  or b.config->>'method'<>'catalog'
  or r.generated_url is distinct from b.generated_url
  or r.config->>'materialId' is distinct from b.config->>'materialId'
  or r.config->'catalog'->>'productCount' is distinct from b.config->'catalog'->>'productCount'
  or private.launch_restitch_config_identity(r.config->'catalog') is distinct from private.launch_restitch_config_identity(b.config->'catalog')
  or private.launch_material_identity(r.sources) is null
  or private.launch_material_identity(r.sources) is distinct from private.launch_material_identity(b.sources)
  or r.sources->>'catalogSettingsVersion' is null
  or r.sources->>'catalogSettingsVersion' is distinct from b.sources->>'catalogSettingsVersion'
  or r.sources->>'restitchSettingsVersion' is distinct from b.sources->>'restitchSettingsVersion' then return false;end if;
 -- Catalog reuse must prove the actual video too, including historical reuse mistakes.
 if r.config->'catalog'->>'restitchEnabled'='true' and private.launch_reusable_restitch(p_team,p_generation) is null then return false;end if;
 if not exists(select 1 from public.team_product_catalogs p join public.team_materials m on m.id=p.material_id and m.team_id=p.team_id where p.team_id=p_team and p.material_id=c.material_id and p.source_link=r.generated_url and p.sheet_url=c.sheet_url and m.lifecycle='active') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if c.restitch_material_id is not null and not exists(select 1 from public.team_materials where team_id=p_team and id=c.restitch_material_id and lifecycle='active') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 insert into public.team_launch_revision_catalogs select team_id,r.id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=c.revision_id on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',result_material_id=c.material_id,reserved_variant=c.variant where generation_id=g.id and stage='catalog_registering';
 return true;
end $$;
commit;
