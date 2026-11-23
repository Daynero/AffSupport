-- 064, pre-release review 2026-11-22.
--
-- 1. A card that changes something is claimed before the browser acts on it, not remembered after:
--    «Не треба» in one tab, a second tab, a reload in the middle, or a lost confirmation could run
--    the same deletions, moves or invitations twice. assistant_card_claim moves open → confirmed
--    and refuses anything else; assistant_card_finish then stores what happened (rows done and
--    failed) and, when nothing happened, puts the card back to open or marks it stale.
-- 2. A launch whose batch was not accepted goes back from launched to open with its batch key, so
--    the card stops saying «Передано в генерацію» and a second press reuses the same key.
-- 3. Indexes on command_id for the cascades and lookups that scan assistant cards and messages.
-- 4. A command whose function died after the debit (a killed isolate) is swept: after the hold
--    window it is marked unknown and its credits come back.

create function public.assistant_card_claim(p_card uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_card private.assistant_cards;
  v_conversation private.assistant_conversations;
  v_purpose text;
begin
  if auth.uid() is null or p_card is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select * into v_card from private.assistant_cards c where c.id = p_card for update;
  select * into v_conversation from private.assistant_conversations c where c.id = v_card.conversation_id;
  v_purpose := coalesce(v_card.payload ->> 'purpose', '');
  if v_card.id is null or v_conversation.user_id is distinct from auth.uid()
     or not private.can(v_conversation.team_id, 'view', auth.uid())
     or v_card.kind <> 'review'
     or v_purpose not in ('archive', 'release', 'tool')
     or (v_purpose <> 'tool' and not private.can(v_conversation.team_id, 'edit', auth.uid())) then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if v_card.state <> 'open' then
    raise exception 'REVIEW_CHANGED' using errcode = 'PT409';
  end if;
  update private.assistant_cards set state = 'confirmed', updated_at = now()
  where id = p_card returning * into v_card;
  return private.assistant_card_json(v_card);
end;
$$;

create function public.assistant_card_finish(p_card uuid, p_state text, p_result jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_card private.assistant_cards;
  v_conversation private.assistant_conversations;
  v_result jsonb := '{}'::jsonb;
  v_key text;
begin
  if auth.uid() is null or p_card is null or p_state not in ('confirmed', 'open', 'stale')
     or (p_result is not null and jsonb_typeof(p_result) <> 'object') then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  -- Only counts, never anything else the browser might send.
  foreach v_key in array array['done', 'failed', 'archived', 'released'] loop
    if p_result ? v_key and jsonb_typeof(p_result -> v_key) = 'number'
       and (p_result ->> v_key)::numeric between 0 and 100000 then
      v_result := v_result || jsonb_build_object(v_key, (p_result ->> v_key)::integer);
    end if;
  end loop;
  select * into v_card from private.assistant_cards c where c.id = p_card for update;
  select * into v_conversation from private.assistant_conversations c where c.id = v_card.conversation_id;
  if v_card.id is null or v_conversation.user_id is distinct from auth.uid() then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  -- A claimed action card settles; a launched card goes back only to open (its batch failed).
  if not (
    (v_card.state = 'confirmed' and v_card.kind = 'review'
       and coalesce(v_card.payload ->> 'purpose', '') in ('archive', 'release', 'tool'))
    or (v_card.state = 'launched' and p_state = 'open')
  ) then
    raise exception 'REVIEW_CHANGED' using errcode = 'PT409';
  end if;
  update private.assistant_cards
  set state = p_state, payload = payload || v_result, updated_at = now()
  where id = p_card returning * into v_card;
  return private.assistant_card_json(v_card);
end;
$$;

revoke all on function public.assistant_card_claim(uuid) from public, anon;
revoke all on function public.assistant_card_finish(uuid, text, jsonb) from public, anon;
grant execute on function public.assistant_card_claim(uuid) to authenticated;
grant execute on function public.assistant_card_finish(uuid, text, jsonb) to authenticated;

create index if not exists assistant_cards_command on private.assistant_cards (command_id);
create index if not exists assistant_messages_command on private.assistant_messages (command_id);

create function public.service_assistant_sweep_stuck(p_user uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command record;
  v_count integer := 0;
begin
  if p_user is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  for v_command in
    select c.id from private.assistant_commands c
    where c.user_id = p_user
      and c.status in ('accepted', 'parsing', 'executing')
      and c.updated_at < now() - private.ai_hold_window()
    order by c.created_at
    limit 20
    for update skip locked
  loop
    update private.assistant_commands
    set status = 'unknown', reason_code = coalesce(reason_code, 'INTERRUPTED'), updated_at = now()
    where id = v_command.id;
    perform public.service_ai_credit_refund(p_user, 'launch_assistant:' || v_command.id::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.service_assistant_sweep_stuck(uuid) from public, anon, authenticated;
grant execute on function public.service_assistant_sweep_stuck(uuid) to service_role;
