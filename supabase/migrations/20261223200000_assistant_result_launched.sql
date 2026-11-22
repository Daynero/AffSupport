-- 064: «Запустити N» on a result card is remembered like on a review card: a reopened dialog
-- says «Передано в генерацію» instead of offering to launch the same drafts again.
create or replace function public.assistant_review_launched(p_card uuid, p_batch_key uuid)
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
  if auth.uid() is null or p_card is null or p_batch_key is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select * into v_card from private.assistant_cards c where c.id = p_card for update;
  select * into v_conversation from private.assistant_conversations c where c.id = v_card.conversation_id;
  if v_card.id is null or v_conversation.user_id is distinct from auth.uid()
     or not private.can(v_conversation.team_id, 'edit', auth.uid()) or v_card.kind not in ('review', 'result') then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if v_card.state = 'launched' then
    if v_card.payload ->> 'batchKey' is distinct from p_batch_key::text then
      raise exception 'KEY_REUSED' using errcode = 'PT409';
    end if;
    return private.assistant_card_json(v_card);
  end if;
  if v_card.state <> 'open' then
    raise exception 'REVIEW_CHANGED' using errcode = 'PT409';
  end if;
  update private.assistant_cards
  set state = 'launched', payload = payload || jsonb_build_object('batchKey', p_batch_key::text),
      updated_at = now()
  where id = p_card
  returning * into v_card;
  return private.assistant_card_json(v_card);
end;
$$;
