-- Prevent cascades from erasing held ranges or an active accepted recipe.
-- This is a storage fence, not native execution/quiescence or retirement proof.
begin;
create function private.guard_restitch_selection_deletion() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare operation_state text;
begin
 -- Deletion already holds the root row. Do not wait in reverse order behind
 -- an issued-range writer; a failed NOWAIT preserves the entire deletion txn.
 perform 1 from private.restitch_selection_slots where root_operation_id=old.root_operation_id
  order by slot for update nowait;
 if exists(select 1 from private.restitch_selection_slots s,
  lateral jsonb_array_elements(s.budget->'transfers') t
  where s.root_operation_id=old.root_operation_id and t->'settlement'='null'::jsonb) then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 select state into operation_state from public.team_operations where id=old.root_operation_id;
 if operation_state is null then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if operation_state in('pending','running') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 -- Protocol1 admission has no wired executor-retirement proof yet. Missing
 -- proof is not quiescence, even if someone marked the parent terminal.
 -- Replace this conservative fence only alongside the verified owned-executor
 -- lifecycle; do not enable a product producer while retirement is incomplete.
 if old.recipe ? 'selectionProtocol' then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 return old;
exception when lock_not_available then
 raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';
end $fn$;
revoke all on function private.guard_restitch_selection_deletion() from public,anon,authenticated,service_role;
create trigger restitch_selection_deletion_fence before delete on private.restitch_selection_roots
 for each row execute function private.guard_restitch_selection_deletion();
commit;
