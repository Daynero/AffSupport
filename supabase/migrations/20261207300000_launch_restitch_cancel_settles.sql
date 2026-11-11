-- Canceled Launch generations of the pre-catalog-video restitch path stayed
-- 'canceled_with_cleanup_pending' forever (production, 2026-10-29 and
-- 2026-11-01, still spinning on 2026-11-11):
--  * the restitch finished and registered its video before the cancellation
--    landed: settlement waited for a failed/canceled operation that would never
--    come, and the video cleanup lane only claims failed/canceled operations;
--  * the upload had started but no marked file ever reached Drive: every claim
--    searched, found nothing, and could only say "pending" again.
--
-- Now:
--  * a succeeded restitch whose output is a registered material is retained
--    (cancellation never trashes a registered material) and settles;
--  * a complete search that finds no marked file, repeated at least ten minutes
--    later, proves absence once the upload can no longer complete: the agent
--    acknowledged quiescence an hour ago, or the operation ended longer ago than
--    a provider resumable upload session lives (seven days);
--  * whatever stays unproven settles after those seven days anyway, leaving any
--    provider object untouched and the outcome in the step checkpoint.
begin;

create table private.launch_video_absence_observations(
 operation_id uuid primary key,
 team_id uuid not null,
 first_observed_at timestamptz not null default clock_timestamp(),
 last_observed_at timestamptz not null default clock_timestamp()
);
alter table private.launch_video_absence_observations enable row level security;
alter table private.launch_video_absence_observations force row level security;
revoke all on private.launch_video_absence_observations from public,anon,authenticated,service_role;

-- Called under the video cleanup lease after a complete Drive search returned no
-- marked file for this operation. Answers 'absent' once absence is proven, and
-- then closes the upload as having nothing to clean and releases the lease.
create function public.service_note_launch_video_absent(p_team uuid,p_generation uuid,p_operation uuid,p_owner uuid,p_fence text) returns text
language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;o public.team_operations%rowtype;
 i private.team_operation_intents%rowtype;seen private.launch_video_absence_observations%rowtype;
begin
 -- Match cleanup's aggregate/generation/operation lock order.
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into o from public.team_operations where id=p_operation and team_id=p_team for update;
 select * into i from private.team_operation_intents where operation_id=p_operation and team_id=p_team for update;
 if l.id is null or g.id is null or o.id is null or i.operation_id is null or g.state<>'canceled_with_cleanup_pending'
  or p_owner is null or p_fence is null or g.lease_owner is distinct from p_owner::text
  or g.fence::text is distinct from p_fence or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()
  or o.actor_id is distinct from g.actor_id or o.kind<>'process' or o.state not in('failed','canceled')
  or o.result_material_id is not null or i.tool_id is distinct from 'restitch' or i.launch_upload_phase is distinct from 'started'
  or i.provider_result_id is not null
  or not exists(select 1 from private.launch_restitch_preparations p where p.generation_id=g.id and p.team_id=g.team_id
   and p.actor_id=g.actor_id and (p.operation_id=o.id or p.process_key=o.idempotency_key))
 then return 'unknown';end if;
 -- A gap of more than half an hour (a found file, a failing search) starts the
 -- observation over: absence must be seen twice in a row.
 insert into private.launch_video_absence_observations(operation_id,team_id) values(o.id,g.team_id)
 on conflict(operation_id) do update set
  first_observed_at=case when private.launch_video_absence_observations.last_observed_at<clock_timestamp()-interval '30 minutes'
   then clock_timestamp() else private.launch_video_absence_observations.first_observed_at end,
  last_observed_at=clock_timestamp()
 returning * into seen;
 if seen.first_observed_at>clock_timestamp()-interval '10 minutes' then return 'pending';end if;
 if not (i.launch_upload_quiesced_at is not null and i.launch_upload_quiesced_at<=clock_timestamp()-interval '1 hour')
  and coalesce(o.finished_at,o.updated_at)>clock_timestamp()-interval '7 days' then return 'pending';end if;
 update private.team_operation_intents set launch_upload_phase='cleaned',updated_at=clock_timestamp() where operation_id=o.id;
 update public.team_launch_generation_steps set checkpoint=coalesce(checkpoint,'{}'::jsonb)||'{"cleanupOutcome":"provider_output_absent"}'::jsonb,
  updated_at=clock_timestamp() where generation_id=g.id and team_operation_id=o.id;
 update public.team_launch_generations set lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp(),
  state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return 'absent';
end $$;
revoke all on function public.service_note_launch_video_absent(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_note_launch_video_absent(uuid,uuid,uuid,uuid,text) to service_role;

-- Settlement: the body of 20261201154000 as amended by 20261201179000,
-- 20261201182000 and 20261207097000, plus the two closures above.
create or replace function public.service_settle_launch_restitch_cancellations(p_limit integer default 3) returns integer
language plpgsql security definer set search_path='' as $$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;p private.launch_restitch_preparations%rowtype;op record;settled boolean;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id from public.team_launch_generations x join private.launch_restitch_preparations prep on prep.generation_id=x.id
  where x.state in('cancel_requested','canceled_with_cleanup_pending')
   and (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=x.team_id and i.request_key='launch:'||x.id::text||':catalog')
  order by x.updated_at,x.id limit p_limit
 loop
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('cancel_requested','canceled_with_cleanup_pending')
   or g.next_attempt_at>clock_timestamp() or g.lease_expires_at>clock_timestamp() then continue;end if;
  select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
  settled:=true;
  for op in select o.*,i.expected_size,i.provider_result_id,i.tool_id,i.launch_upload_phase from public.team_operations o
   left join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
   where o.team_id=g.team_id and (o.id=p.operation_id or o.idempotency_key=p.process_key or exists(
    select 1 from public.team_launch_generation_steps s where s.generation_id=g.id and s.team_operation_id=o.id))
   for update of o
  loop
   -- The restitch finished and its video is a registered material: retain it.
   if op.actor_id=g.actor_id and op.kind='process' and op.tool_id='restitch' and op.state='succeeded'
    and ((op.result_material_id is not null and exists(select 1 from public.team_materials m where m.id=op.result_material_id and m.team_id=g.team_id))
     or (op.provider_result_id is not null and exists(select 1 from public.team_materials m where m.team_id=g.team_id and m.drive_file_id=op.provider_result_id))) then
    if op.launch_upload_phase is distinct from 'retained' then
     update private.team_operation_intents set launch_upload_phase='retained',launch_upload_quiesced_at=coalesce(launch_upload_quiesced_at,clock_timestamp()),
      updated_at=clock_timestamp() where operation_id=op.id and team_id=g.team_id;
     update public.team_launch_generation_steps set checkpoint=coalesce(checkpoint,'{}'::jsonb)||'{"cleanupOutcome":"retained_catalog_material"}'::jsonb,
      updated_at=clock_timestamp() where generation_id=g.id and team_operation_id=op.id;
    end if;
    continue;
   end if;
   -- An upload nobody could prove or clean within a provider upload session's
   -- lifetime: stop waiting, touch nothing, keep the outcome on the step.
   if op.actor_id=g.actor_id and op.kind='process' and op.tool_id='restitch' and op.state in('failed','canceled')
    and op.launch_upload_phase='started' and op.provider_result_id is null and op.result_material_id is null
    and coalesce(op.finished_at,op.updated_at)<=clock_timestamp()-interval '7 days' then
    update public.team_launch_generation_steps set checkpoint=coalesce(checkpoint,'{}'::jsonb)||'{"cleanupOutcome":"provider_output_unverified"}'::jsonb,
     updated_at=clock_timestamp() where generation_id=g.id and team_operation_id=op.id
     and checkpoint->>'cleanupOutcome' is distinct from 'provider_output_unverified';
    continue;
   end if;
   if op.actor_id is distinct from g.actor_id or op.kind<>'process' or op.tool_id is distinct from 'restitch'
    or op.state not in('failed','canceled') or
    (op.expected_size is not null and op.launch_upload_phase is distinct from 'not_started'
      and op.launch_upload_phase is distinct from 'cleaned' and op.launch_upload_phase is distinct from 'retained')
    or (op.provider_result_id is not null and op.launch_upload_phase is distinct from 'cleaned' and op.launch_upload_phase is distinct from 'retained')
    or op.result_material_id is not null then settled:=false;end if;
  end loop;
  update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
   stage=case when settled then 'cancel' else 'cleanup' end,safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,
   state_version=state_version+1,next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
   lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=g.id;
  if settled then update public.team_launch_generation_steps set state='canceled',updated_at=clock_timestamp() where generation_id=g.id and state in('pending','running');end if;
  perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);n:=n+1;
 end loop;
 return n;
end $$;

commit;
