-- 064: the assistant does everything in a space, not only launches (owner, 2026-11-22). A read
-- tool answers with a `table` card — numbers and names from the database; a write tool shows a
-- `review` card with purpose 'tool', the browser performs it through the screens' own API when the
-- person presses the button, and the card is remembered as done like a removal card.
alter table private.assistant_cards drop constraint if exists assistant_cards_kind_check;
alter table private.assistant_cards add constraint assistant_cards_kind_check
  check (kind in ('result', 'question', 'review', 'status', 'profile', 'refusal', 'table'));

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
  -- A tool card may need only «view» in the space (an invitation, a task); the action it performs
  -- checks its own right. Remembering it as done needs only that the card is the person's own.
  if v_card.id is null or v_conversation.user_id is distinct from auth.uid()
     or not private.can(v_conversation.team_id, 'view', auth.uid())
     or v_card.kind <> 'review'
     or coalesce(v_card.payload ->> 'purpose', '') not in ('archive', 'release', 'tool')
     or (coalesce(v_card.payload ->> 'purpose', '') <> 'tool'
         and not private.can(v_conversation.team_id, 'edit', auth.uid())) then
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
