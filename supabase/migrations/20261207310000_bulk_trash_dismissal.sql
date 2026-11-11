-- 1.4.3: a closed «Перенесення файлів до кошика» panel came back on every reload.
-- Hiding it lived only in the tab's memory, while list_team_bulk_trash keeps
-- returning the team's last fifty groups, so each reload replayed finished work
-- (and other members' finished work) three panels at a time.
--
-- Hiding is now a per-viewer receipt. The list still returns every group (the
-- client reconciles its local intents against them), marked `dismissed` when the
-- viewer closed it, or when it is finished and either belongs to someone else or
-- is older than a day: finished work has nothing left to report after that.
--
-- The table is named outside the team_/catalog_ families on purpose: it holds
-- no material reference, so it stays out of the task-attachment cleanup fence
-- (private.task_cleanup_reference_tables), which would otherwise demand a guard.
begin;

create table private.bulk_trash_dismissals (
 group_id uuid not null references private.team_bulk_trash_groups(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 dismissed_at timestamptz not null default now(),
 primary key(group_id,actor_id)
);
alter table private.bulk_trash_dismissals enable row level security;
alter table private.bulk_trash_dismissals force row level security;
revoke all on private.bulk_trash_dismissals from public,anon,authenticated,service_role;

create function public.dismiss_team_bulk_trash(p_team uuid,p_group uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if not exists(select 1 from private.team_bulk_trash_groups where id=p_group and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 insert into private.bulk_trash_dismissals(group_id,actor_id) values(p_group,auth.uid()) on conflict do nothing;
end $$;
revoke all on function public.dismiss_team_bulk_trash(uuid,uuid) from public,anon;
grant execute on function public.dismiss_team_bulk_trash(uuid,uuid) to authenticated;

create or replace function public.list_team_bulk_trash(p_team uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid();
begin
 if viewer is null or not private.can(p_team,'view',viewer) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(s.snapshot || jsonb_build_object('dismissed',
   exists(select 1 from private.bulk_trash_dismissals d where d.group_id=s.id and d.actor_id=viewer)
   or ((s.actor_id<>viewer or s.created_at<now()-interval '1 day')
    and jsonb_array_length(s.snapshot->'items')>0
    and not exists(select 1 from jsonb_array_elements(s.snapshot->'items') e where e->>'state'<>'confirmed' or e ? 'historicalReceipt'))
  ) order by s.created_at desc) from
  (select g.id,g.actor_id,g.created_at,private.bulk_trash_snapshot(g.id) snapshot from
   (select id,actor_id,created_at from private.team_bulk_trash_groups where team_id=p_team order by created_at desc limit 50) g) s),'[]'::jsonb);
end $$;

commit;
