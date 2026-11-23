-- 064: a command undone in full leaves its result cards marked so: a reopened dialog no longer
-- offers «Запустити N» or «Скасувати» on drafts that were removed or put back.
create function public.service_assistant_cards_undone(p_command uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.assistant_cards
  set state = 'undone', updated_at = now()
  where command_id = p_command and state = 'open' and kind in ('result', 'review');
$$;

revoke all on function public.service_assistant_cards_undone(uuid) from public, anon, authenticated;
grant execute on function public.service_assistant_cards_undone(uuid) to service_role;
