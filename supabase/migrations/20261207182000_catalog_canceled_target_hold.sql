-- Holding the exact existing target grants no new delivery or target authority.
-- Retry only the original cancellation's parent closure after known set quiescence.
begin;
do $hold$
declare d text;needle text:='and s.state not in(''canceled'',''cancel_requested'') and private.catalog_video_recipe_consumer_allowed';
begin
 select pg_get_functiondef('public.service_save_catalog_publication(uuid,uuid,uuid,uuid,bigint,text,timestamptz,text,jsonb)'::regprocedure)into d;
 if strpos(d,needle)=0 then raise exception 'CATALOG_HELD_TARGET_SEAM_CHANGED';end if;
 d:=replace(d,needle,'and (s.state not in(''canceled'',''cancel_requested'') or (p_mode=''held'' and p_target=private.catalog_publication_target_json(p.target_id))) and private.catalog_video_recipe_consumer_allowed');execute d;
end $hold$;
do $quiescent$
declare d text;needle text:='if s.id is null or s.state<>''cancel_requested''then return false;end if;';
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure)into d;
 if strpos(d,needle)=0 then raise exception 'CATALOG_CANCEL_PROOF_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$if s.id is null or s.state not in('cancel_requested','canceled')then return false;end if;
 if s.state='canceled'and not exists(select 1 from private.launch_catalog_video_contexts original join public.team_launch_generations parent on parent.id=original.generation_id and parent.team_id=original.team_id and parent.actor_id=original.actor_id where original.video_set_id=s.id and original.catalog_intent_id=s.catalog_intent_id and original.team_id=s.team_id and original.actor_id=s.actor_id and parent.state in('cancel_requested','canceled_with_cleanup_pending'))then return false;end if;$replace$);execute d;
end $quiescent$;
do $parent$
declare d text;needle text:='from private.catalog_video_sets where state=''cancel_requested''order by updated_at,id limit p_limit';
begin
 select pg_get_functiondef('public.service_settle_catalog_video_cancellations(integer)'::regprocedure)into d;
 if strpos(d,needle)=0 or strpos(d,'where id=candidate.id and state=''cancel_requested''for update skip locked')=0 or strpos(d,'where id=s.id;')=0 then raise exception 'CATALOG_CANCEL_PARENT_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$from private.catalog_video_sets where state='cancel_requested'or(state='canceled'and exists(select 1 from private.launch_catalog_video_contexts original join public.team_launch_generations parent on parent.id=original.generation_id and parent.team_id=original.team_id and parent.actor_id=original.actor_id where original.video_set_id=catalog_video_sets.id and original.catalog_intent_id=catalog_video_sets.catalog_intent_id and original.team_id=catalog_video_sets.team_id and original.actor_id=catalog_video_sets.actor_id and parent.state in('cancel_requested','canceled_with_cleanup_pending')))order by updated_at,id limit p_limit$replace$);
 d:=replace(d,'where id=candidate.id and state=''cancel_requested''for update skip locked','where id=candidate.id and state in(''cancel_requested'',''canceled'')for update skip locked');
 d:=replace(d,'update private.catalog_video_sets set state=''canceled'',revision=revision+1,updated_at=clock_timestamp()where id=s.id;','update private.catalog_video_sets set state=''canceled'',revision=revision+1,updated_at=clock_timestamp()where id=s.id and state=''cancel_requested'';');
 execute d;
end $parent$;
commit;
