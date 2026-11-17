-- next QA 2026-11-17: service_list_initial_catalog_recovery was the heaviest statement on the
-- shared database — called every minute, 875 ms on average and 6.3 s at worst, 45 minutes of
-- database time across three thousand calls.
--
-- It handed each intent row whole to private.initial_publication_reverify_owed(i), which hands
-- it on to private.initial_publication_catalog_active(i). A whole-row argument is built by
-- detoasting every column of the row, and an intent carries its request, checkpoint and result
-- documents, so each call cost ~7 ms for what is a primary-key lookup — for every registered
-- intent, before the pacing table or the permission checks could exclude it. private.can also
-- ran for all 731 intents, ~1 ms a call, twice.
--
-- The listing now asks the same questions of the columns it needs, cheapest first: due
-- intents, and registered ones that are not paced and still lack a finished check; then, for
-- those few, the parts of the owed test (initial_publication_reverify_owed, 20261207280000,
-- column by column) that read the ~100 kB checkpoint; and only then the permission and
-- video-set checks. The
-- answer and its order are unchanged; the two helper functions stay for the claim path,
-- which reads one row.
begin;

create or replace function public.service_list_initial_catalog_recovery(p_limit integer default 3)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 3 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return coalesce((
    with candidates as materialized (
      -- Cheap columns first. An intent's checkpoint averages ~100 kB compressed, and every
      -- read of it is a detoast, so only the few intents that can still owe a check read it.
      select i.id, i.team_id, i.actor_id, i.request_key, i.next_attempt_at, i.state, i.created_at,
             i.request_payload->>'restitchEnabled' as restitch,
             i.request_payload#>>'{videoPublication,mode}' as publication_mode
        from private.catalog_generation_intents i
       where i.request_payload->>'catalogVideoProtocolVersion' = '1'
         and i.request_key ~ '^product-catalog:[0-9a-f-]{36}$'
         and (
           (i.state in ('interrupted', 'create_started', 'created', 'finalized')
             and i.next_attempt_at <= statement_timestamp()
             and (i.lease_expires_at is null or i.lease_expires_at <= statement_timestamp()))
           or (
             i.state = 'registered'
             and not exists (
               select 1 from private.catalog_initial_publication_reverify r
                where r.intent_id = i.id
                  and (r.exhausted_at is not null or r.retry_after > statement_timestamp()))
             and (
               exists (
                 select 1
                   from private.catalog_initial_publication_checks ic
                   join private.catalog_video_publication_jobs j on j.id = ic.job_id
                  where ic.intent_id = i.id and ic.state = 'reading'
                    and j.state = 'blocked' and j.blocked_reason = 'legacy_adoption_required')
               or (
                 i.created_at > statement_timestamp() - interval '7 days'
                 and not exists (
                   select 1 from private.catalog_initial_publication_checks ic where ic.intent_id = i.id)
               )
             )
           )
         )
    ),
    owed as materialized (
      select c.*
        from candidates c
        join private.catalog_generation_intents i on i.id = c.id
        left join lateral (
          select jsonb_typeof(i.checkpoint->'initialVideoPlan') as plan_type,
                 case when i.checkpoint->>'materialId'
                           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                      then (i.checkpoint->>'materialId')::uuid end as material_id
           where c.state = 'registered'
        ) ck on true
       where c.state <> 'registered'
          or (
            -- private.initial_publication_reverify_owed (20261207280000), by column; the
            -- pacing and the parts without the checkpoint were already asked above.
            ck.plan_type = 'object'
            and ck.material_id is not null
            and exists (
              select 1 from public.team_materials m
               where m.id = ck.material_id and m.team_id = c.team_id and m.lifecycle = 'active')
            and (
              exists (
                select 1
                  from private.catalog_initial_publication_checks ic
                  join private.catalog_video_publication_jobs j on j.id = ic.job_id
                 where ic.intent_id = c.id and ic.state = 'reading'
                   and j.state = 'blocked' and j.blocked_reason = 'legacy_adoption_required')
              or (
                c.created_at > statement_timestamp() - interval '7 days'
                and not exists (
                  select 1 from private.catalog_initial_publication_checks ic where ic.intent_id = c.id)
                and not exists (
                  select 1 from private.catalog_video_publication_policies p
                   where p.catalog_material_id = ck.material_id)
              )
            )
          )
    ),
    listed as (
      select o.team_id, o.actor_id, o.request_key, o.next_attempt_at, o.id,
             (o.state = 'registered') as reverify
        from owed o
       where private.can(o.team_id, 'view', o.actor_id)
         and private.can(o.team_id, 'upload', o.actor_id)
         and (o.restitch = 'false' or private.can(o.team_id, 'process', o.actor_id))
         and (
           o.restitch = 'false'
           or o.publication_mode = 'scheduled'
           or exists (
             select 1 from private.catalog_video_sets s
              where s.catalog_intent_id = o.id and s.team_id = o.team_id
                and s.actor_id = o.actor_id and s.state = 'ready')
         )
       order by (o.state = 'registered'), o.next_attempt_at, o.id
       limit p_limit
    )
    select jsonb_agg(
             jsonb_build_object('teamId', x.team_id, 'actorId', x.actor_id, 'idempotencyKey', x.request_key)
             order by x.reverify, x.next_attempt_at, x.id)
      from listed x
  ), '[]'::jsonb);
end;
$$;

commit;
