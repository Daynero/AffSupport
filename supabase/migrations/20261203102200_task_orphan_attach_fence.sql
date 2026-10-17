-- Once a worker owns an orphan claim, an attachment must not silently cancel
-- that claim while the provider request can still move the file to trash.
create function private.guard_task_attach_during_orphan_claim()
returns trigger language plpgsql security definer set search_path = '' as $$
declare intent_state text;
begin
  -- Lock waiting intents as well: the existing AFTER INSERT trigger cancels
  -- them before a claimant can acquire the same row.
  for intent_state in select i.state from private.team_task_orphan_intents i
    where i.team_id = new.team_id and i.material_id = new.material_id
      and i.state in ('waiting', 'claimed') for update
  loop
    if intent_state = 'claimed' then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
  end loop;
  return new;
end $$;
revoke all on function private.guard_task_attach_during_orphan_claim()
  from public, anon, authenticated;
create trigger guard_task_attach_during_orphan_claim
  before insert on public.team_task_attachments
  for each row execute function private.guard_task_attach_during_orphan_claim();
