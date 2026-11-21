-- 064: the assistant can propose removing drafts. Its card lists the drafts and a «Видалити N»
-- button; the browser archives them with the person's own rights through archive_launch, then
-- marks the card done so a reopened dialog shows it as done rather than offering it again.
create function public.assistant_card_confirmed(p_card uuid)
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
     or v_card.kind <> 'review' or v_card.payload ->> 'purpose' is distinct from 'archive' then
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

revoke all on function public.assistant_card_confirmed(uuid) from public, anon;
grant execute on function public.assistant_card_confirmed(uuid) to authenticated;
