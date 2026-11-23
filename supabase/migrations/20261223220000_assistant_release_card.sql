-- 064: «звільни всі РК» — the assistant shows the busy ad accounts with a «Звільнити N» button;
-- the browser releases each through release_team_agent_assignments, as the Accounts tab does, and
-- the card is remembered as done like a removal card.
create or replace function public.assistant_card_confirmed(p_card uuid)
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
     or not private.can(v_conversation.team_id, 'edit', auth.uid())
     or v_card.kind <> 'review' or coalesce(v_card.payload ->> 'purpose', '') not in ('archive', 'release') then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if v_card.state = 'open' then
    update private.assistant_cards set state = 'confirmed', updated_at = now()
    where id = p_card returning * into v_card;
  elsif v_card.state <> 'confirmed' then
    raise exception 'REVIEW_CHANGED' using errcode = 'PT409';
  end if;
  return private.assistant_card_json(v_card);
end;
$$;
