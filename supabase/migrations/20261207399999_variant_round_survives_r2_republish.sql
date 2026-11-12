-- Production 2026-11-12 (MY_1_v4_catalog): "copy video to R2" was ticked and an update with
-- re-stitch started a second later. The update froze the catalog's publication revision (1)
-- when it asked for its variants; two minutes later the R2 reconciliation republished the old
-- video to R2 as revision 2. When the variants were ready, attaching them asked for revision 1,
-- `service_save_catalog_publication` answered WRONG_STATE on every pass, and the round held
-- its catalog for good.
--
-- A revision written by the R2 reconciliation only repeats the same target with other links;
-- it is not a decision the round must respect. Attaching now expects the current revision when
-- every revision after the frozen one came from the R2 reconciliation. Any other publication
-- in between (a person changed the mode or the date) still stops the attach as before.

create function private.catalog_variant_publication_revision(p_request uuid) returns bigint
language sql stable security definer set search_path='' as $$
 select case
  when p.revision>r.publication_revision and not exists(
   select 1 from private.catalog_video_publication_jobs j
   left join private.catalog_publication_commands c on c.request_id=j.command_id and c.team_id=j.team_id
   where j.catalog_material_id=r.catalog_material_id and j.team_id=r.team_id
    and j.revision>r.publication_revision and j.revision<=p.revision
    and coalesce(c.payload->>'origin','') is distinct from 'video_r2')
  then p.revision
  else r.publication_revision end
 from private.catalog_updater_variant_requests r
 left join private.catalog_video_publication_policies p on p.catalog_material_id=r.catalog_material_id and p.team_id=r.team_id
 where r.request_id=p_request
$$;
revoke all on function private.catalog_variant_publication_revision(uuid) from public,anon,authenticated,service_role;

do $attach$
declare d text;
begin
 select pg_get_functiondef('public.service_attach_catalog_updater_variant_target(uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$r.catalog_material_id,r.publication_revision,mode,due,zone,$find$)=0
 then raise exception 'VARIANT_R2_REVISION_PATCH_MISSING';end if;
 d:=replace(d,$find$r.catalog_material_id,r.publication_revision,mode,due,zone,$find$,
  $replace$r.catalog_material_id,private.catalog_variant_publication_revision(r.request_id),mode,due,zone,$replace$);
 execute d;
end $attach$;
