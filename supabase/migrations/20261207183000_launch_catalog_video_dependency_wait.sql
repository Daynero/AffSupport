-- A registered blank catalog does not imply that its original N outputs are ready.
-- Reuse the existing bounded, claimed dependency wait; do not call ready-only attach early.
begin;
do $dependency$
declare d text;needle text:='if (select config->>''method'' from public.team_launch_revisions where id=g.revision_id)=''other''';
begin
 select pg_get_functiondef('public.service_settle_launch_batch(integer)'::regprocedure)into d;
 if strpos(d,needle)=0 or strpos(d,'claimed:=public.service_claim_launch_generation')=0 then raise exception 'LAUNCH_VIDEO_DEPENDENCY_SETTLE_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$if exists(
   select 1 from private.launch_catalog_video_contexts original
   join private.catalog_video_sets video_set on video_set.id=original.video_set_id and video_set.team_id=original.team_id and video_set.actor_id=original.actor_id
   join private.catalog_generation_intents intent on intent.id=original.catalog_intent_id and intent.team_id=original.team_id and intent.actor_id=original.actor_id
   join public.team_product_catalogs catalog on catalog.material_id=(intent.result#>>'{catalog,materialId}')::uuid and catalog.team_id=intent.team_id and catalog.video_material_id=intent.video_material_id
   where original.generation_id=g.id and original.team_id=g.team_id and original.actor_id=g.actor_id
    and intent.state='registered'and intent.request_key='launch:'||g.id::text||':catalog'and intent.request_payload=original.request_payload and intent.checkpoint->'initialVideoPlan'=original.initial_video_plan
    and video_set.catalog_intent_id=intent.id and video_set.source_material_id=intent.video_material_id and original.initial_video_plan->>'setId'=video_set.id::text
    and video_set.state in('accepted','preparing')and video_set.requested_count=(original.initial_video_plan#>>'{preferences,videoVariationCount}')::integer
    and video_set.product_count=catalog.product_count and jsonb_array_length(original.initial_video_plan->'childRequestIds')=video_set.requested_count
    and (select count(*)from private.catalog_video_variants child where child.video_set_id=video_set.id)=video_set.requested_count
    and exists(select 1 from private.catalog_initial_publication_checks proof where proof.intent_id=intent.id and proof.team_id=g.team_id and proof.actor_id=g.actor_id and proof.catalog_material_id=catalog.material_id and proof.state='verified')
    and exists(select 1 from private.catalog_video_variants child where child.video_set_id=video_set.id and child.state in('queued','working'))
    and not exists(select 1 from private.catalog_video_variants child left join public.team_operations operation on operation.team_id=video_set.team_id and operation.actor_id=video_set.actor_id and operation.kind='process'and operation.idempotency_key='catalog-variant:'||child.request_id::text where child.video_set_id=video_set.id and(child.state='unknown'or original.initial_video_plan->'childRequestIds'->>child.video_variant_index is distinct from child.request_id::text or operation.state in('failed','canceled')or(child.operation_id is not null and operation.id is distinct from child.operation_id)))
  )then
   perform public.service_wait_launch_catalog_video(g.team_id,g.id,g.actor_id,owner,claimed->>'fence');
  elsif (select config->>'method' from public.team_launch_revisions where id=g.revision_id)='other'$replace$);
 execute d;
end $dependency$;
commit;
