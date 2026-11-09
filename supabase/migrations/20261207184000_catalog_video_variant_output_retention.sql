-- Catalog video variants are real deliverables, not abandoned restitch copies.
-- The hourly sweep only knew the single-video catalog columns, so every N-variant
-- output in the Restitched folder was retired after one hour and then deleted for
-- good by the updater (observed on beta: 10/10 and 5/5 outputs, published or due).
-- Both the sweep and the delete-time guard now treat any recorded variant output
-- as retained. A retained output can leak; a deleted one cannot be recovered.
begin;
do $sweep$
declare d text;needle text:='    and not exists (
      select 1 from public.team_task_attachments as attachment where attachment.material_id = file.id
    )';
begin
 select pg_get_functiondef('private.retire_unused_restitch_copies(interval,integer)'::regprocedure)into d;
 if strpos(d,needle)=0 then raise exception 'RESTITCH_SWEEP_SEAM_CHANGED';end if;
 d:=replace(d,needle,needle||'
    -- A catalog video variant is owned by its set and its catalog, linked or not yet.
    and not exists (
      select 1 from private.catalog_video_variants as variant
      where variant.team_id = file.team_id and variant.output_material_id = file.id
    )');
 execute d;
end $sweep$;
do $retained$
declare d text;needle text:='select private.launch_output_is_referenced(p_team,p_material)';
begin
 select pg_get_functiondef('private.launch_output_retained(uuid,uuid)'::regprocedure)into d;
 if strpos(d,needle)=0 then raise exception 'LAUNCH_OUTPUT_RETAINED_SEAM_CHANGED';end if;
 d:=replace(d,needle,needle||'
 or exists(select 1 from private.catalog_video_variants variant where variant.team_id=p_team and variant.output_material_id=p_material)');
 execute d;
end $retained$;
-- Already retired variant outputs on a database where the sweep ran: give them back.
delete from public.team_catalog_restitch_copies copy
 where copy.role='retired' and copy.catalog_material_id is null
   and exists(select 1 from private.catalog_video_variants variant
     where variant.team_id=copy.team_id and variant.output_material_id=copy.material_id);
commit;
