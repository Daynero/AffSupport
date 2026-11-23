-- 064: «Діалоги зберігаються 7 днів» is now true.
--
-- A dialog has been hidden a week after its last message since 20261223160000, but nothing ever
-- deleted it: the person's words, the model's plans and the cards stayed in the database for good
-- while the window said seven days. Now a dialog idle for more than seven days (a day of grace on
-- top, so a dialog never vanishes while its window is open) is deleted with its commands,
-- messages, cards and undo effects (all cascade).
--
-- Money is not touched: the credit ledger, usage events and month holds are accounting records
-- keyed by text, with no reference to a dialog.
begin;

create index if not exists assistant_conversations_last_active
  on private.assistant_conversations (last_active_at);

create or replace function private.prune_idle_assistant_dialogs(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
  -- Read once: a variable can bound the index scan, a volatile call in the query cannot.
  cutoff constant timestamptz := clock_timestamp() - interval '8 days';
  stuck uuid;
begin
  -- A command that died after its debit is refunded before its dialog goes: the person may never
  -- send the next message that would sweep it.
  for stuck in
    select distinct command.user_id
    from private.assistant_commands as command
    join private.assistant_conversations as c on c.id = command.conversation_id
    where c.last_active_at < cutoff
      and command.status in ('accepted', 'parsing', 'executing')
  loop
    perform public.service_assistant_sweep_stuck(stuck);
  end loop;
  with idle as (
    select c.id
    from private.assistant_conversations as c
    where c.last_active_at < cutoff
      -- Whatever the sweep could not settle keeps its dialog.
      and not exists (
        select 1 from private.assistant_commands as command
        where command.conversation_id = c.id
          and command.status in ('accepted', 'parsing', 'executing')
      )
    order by c.last_active_at, c.id
    limit least(greatest(coalesce(p_limit, 500), 1), 2000)
  )
  delete from private.assistant_conversations as c
  using idle
  where c.id = idle.id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function private.prune_idle_assistant_dialogs(integer)
  from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soty-assistant-dialog-retention', '41 * * * *',
      $cron$select private.prune_idle_assistant_dialogs()$cron$);
  end if;
end;
$$;

commit;
