-- Parent cancellation revokes known local children, including a start whose reply was lost.
-- Runs inside the parent's aggregate-before-generation transaction.
create function private.cancel_launch_restitch_child() returns trigger language plpgsql security definer set search_path='' as $$
declare preparation private.launch_restitch_preparations%rowtype;child record;
begin
 if new.state not in('cancel_requested','canceled_with_cleanup_pending','canceled') or old.state=new.state then return new;end if;
 select * into preparation from private.launch_restitch_preparations where generation_id=new.id;
 if not found then return new;end if;
 for child in select id from public.team_operations where team_id=new.team_id and actor_id=new.actor_id
   and (id=preparation.operation_id or idempotency_key=preparation.process_key) and state in('pending','running')
 loop
  update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp(),
   reservation_released_at=coalesce(reservation_released_at,clock_timestamp()),error_code=null,retryable=false,updated_at=clock_timestamp() where id=child.id;
  update private.team_transfer_grants set revoked_at=clock_timestamp() where operation_id=child.id and revoked_at is null;
 end loop;
 return new;
end $$;
create trigger team_launch_restitch_cancel_guard after update of state on public.team_launch_generations
 for each row execute function private.cancel_launch_restitch_child();
revoke all on function private.cancel_launch_restitch_child() from public,anon,authenticated;
