-- 064: «Не треба» on a card that would change something. The card stays in the dialog as
-- cancelled, without its button, so a test, a wrong reading or a change of mind is not left armed
-- for a later click (found on next 2026-11-22: «Перейменувати 55», «Видалити 77» stayed live).
create or replace function public.assistant_card_dismissed(p_card uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_card private.assistant_cards;
  v_conversation private.assistant_conversations;
begin
  if auth.uid() is null or p_card is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select * into v_card from private.assistant_cards c where c.id = p_card for update;
  select * into v_conversation from private.assistant_conversations c where c.id = v_card.conversation_id;
  if v_card.id is null or v_conversation.user_id is distinct from auth.uid()
     or not private.can(v_conversation.team_id, 'view', auth.uid())
     or v_card.kind <> 'review'
     or coalesce(v_card.payload ->> 'purpose', '') not in ('archive', 'release', 'tool') then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if v_card.state = 'open' then
    update private.assistant_cards set state = 'stale', updated_at = now()
    where id = p_card returning * into v_card;
  elsif v_card.state <> 'stale' then
    raise exception 'REVIEW_CHANGED' using errcode = 'PT409';
  end if;
  return private.assistant_card_json(v_card);
end;
$$;

revoke all on function public.assistant_card_dismissed(uuid) from public, anon;
grant execute on function public.assistant_card_dismissed(uuid) to authenticated;
