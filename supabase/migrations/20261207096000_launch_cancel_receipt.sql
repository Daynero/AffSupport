-- Return authoritative cancellation readback with the mutation, avoiding a second
-- network round trip before the paired agent can be stopped. Cleanup remains durable.
alter function public.cancel_launch_generation(uuid,uuid,uuid,text)
 rename to cancel_launch_generation_without_readback;
alter function public.cancel_launch_generation_without_readback(uuid,uuid,uuid,text) set schema private;
revoke all on function private.cancel_launch_generation_without_readback(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role;
create function public.cancel_launch_generation(p_team uuid,p_launch uuid,p_generation uuid,p_request_key text)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt jsonb;
begin
 receipt:=private.cancel_launch_generation_without_readback(p_team,p_launch,p_generation,p_request_key);
 return receipt||jsonb_build_object('detail',public.get_launch(p_team,p_launch,null));
end $$;
revoke all on function public.cancel_launch_generation(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.cancel_launch_generation(uuid,uuid,uuid,text) to authenticated;
