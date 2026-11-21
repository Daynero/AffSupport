-- 064: the launch assistant's own state. Drafts themselves stay ordinary team_launches written by
-- the existing commands with the caller's rights; this file only keeps the conversation, the
-- commands and their effects (for «Скасувати»), the cards the server showed, and pasted links.
--
-- Everything is private: the browser reads through functions that check the caller, and the
-- assistant edge function writes through service functions. A conversation belongs to one person
-- in one space and lives seven days after its last activity; losing the space closes it at once.

create table private.ai_space_pilot (
  team_id uuid primary key references public.teams (id) on delete cascade,
  enabled_by uuid references auth.users (id) on delete set null,
  enabled_at timestamptz not null default now()
);

create table private.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  unique (team_id, user_id)
);
create index assistant_conversations_active on private.assistant_conversations (last_active_at);

create table private.assistant_commands (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references private.assistant_conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  client_key text not null check (client_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('message', 'answer', 'confirm', 'undo')),
  status text not null default 'accepted' check (status in (
    'accepted', 'parsing', 'waiting_answer', 'executing', 'done', 'partial', 'rejected', 'unknown', 'undone'
  )),
  price integer not null default 0 check (price between 0 and 10),
  model text check (model ~ '^claude-[a-z0-9-]{3,40}$'),
  -- The checked plan, with links as ⟦url:N⟧ markers only.
  plan jsonb,
  reason_code text check (reason_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);
create index assistant_commands_conversation on private.assistant_commands (conversation_id, created_at);

-- Cards are built by the server from checked state; a message lists the cards it showed.
create table private.assistant_cards (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references private.assistant_conversations (id) on delete cascade,
  command_id uuid references private.assistant_commands (id) on delete cascade,
  kind text not null check (kind in ('result', 'question', 'review', 'status', 'profile', 'refusal')),
  state text not null default 'open' check (state in ('open', 'answered', 'confirmed', 'launched', 'stale', 'undone')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_cards_conversation on private.assistant_cards (conversation_id, created_at);

create table private.assistant_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references private.assistant_conversations (id) on delete cascade,
  command_id uuid references private.assistant_commands (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text not null check (char_length(text) <= 4000),
  price integer not null default 0 check (price between 0 and 10),
  card_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index assistant_messages_conversation on private.assistant_messages (conversation_id, id);

create table private.assistant_command_effects (
  command_id uuid not null references private.assistant_commands (id) on delete cascade,
  step integer not null check (step between 0 and 1000),
  row_key text not null check (row_key ~ '^[A-Za-z0-9:_-]{1,80}$'),
  kind text not null check (kind in ('draft_created', 'draft_updated', 'defaults_saved')),
  team_id uuid not null references public.teams (id) on delete cascade,
  launch_id uuid,
  offer_id uuid,
  version_before text,
  version_after text,
  -- [{path, before, after}] for field edits and profile saves.
  fields jsonb not null default '[]' check (jsonb_typeof(fields) = 'array'),
  undone_at timestamptz,
  primary key (command_id, step, row_key)
);

create table private.assistant_url_slots (
  command_id uuid not null references private.assistant_commands (id) on delete cascade,
  slot integer not null check (slot between 1 and 50),
  value text not null check (char_length(value) <= 8192),
  primary key (command_id, slot)
);

-- 064: which drafts the assistant made, for the «з помічника» mark and «Скасувати».
alter table public.team_launches add column created_via text check (created_via in ('form', 'assistant'));
alter table public.team_launches add column assistant_command_id uuid;

alter table private.ai_space_pilot enable row level security;
alter table private.ai_space_pilot force row level security;
alter table private.assistant_conversations enable row level security;
alter table private.assistant_conversations force row level security;
alter table private.assistant_commands enable row level security;
alter table private.assistant_commands force row level security;
alter table private.assistant_cards enable row level security;
alter table private.assistant_cards force row level security;
alter table private.assistant_messages enable row level security;
alter table private.assistant_messages force row level security;
alter table private.assistant_command_effects enable row level security;
alter table private.assistant_command_effects force row level security;
alter table private.assistant_url_slots enable row level security;
alter table private.assistant_url_slots force row level security;
revoke all on table private.ai_space_pilot, private.assistant_conversations, private.assistant_commands,
  private.assistant_cards, private.assistant_messages, private.assistant_command_effects,
  private.assistant_url_slots from public, anon, authenticated, service_role;

-- jsonb puts these in the attachment-cleanup inventory; without the fence the coverage check turns
-- false and attachment cleanup stops for the whole base.
create trigger task_cleanup_reference_fence before insert or update on private.assistant_commands
  for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.assistant_cards
  for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.assistant_command_effects
  for each row execute function private.guard_task_cleanup_reference();

-- ---------------------------------------------------------------------------------------------
-- Access

create function private.assistant_enabled_for(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.assistant_enabled from private.ai_settings s where s.id), false)
    and exists (select 1 from private.ai_space_pilot p where p.team_id = p_team);
$$;

create function private.assistant_conversation_expire()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from private.assistant_conversations c
  where c.id in (
    select x.id from private.assistant_conversations x
    where x.last_active_at < private.tariff_now() - interval '7 days'
    order by x.last_active_at
    limit 200
  );
$$;

create function private.assistant_card_json(c private.assistant_cards)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'kind', c.kind, 'state', c.state, 'commandId', c.command_id,
    'payload', c.payload, 'createdAt', c.created_at);
$$;

create function private.assistant_message_json(m private.assistant_messages)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'role', m.role, 'text', m.text, 'price', m.price, 'commandId', m.command_id,
    'createdAt', m.created_at,
    'cards', coalesce((
      select jsonb_agg(private.assistant_card_json(c) order by array_position(m.card_ids, c.id))
      from private.assistant_cards c where c.id = any (m.card_ids)
    ), '[]'::jsonb)
  );
$$;

-- The browser's one read: the caller's conversation in a space, its last 50 messages, and credits.
create function public.assistant_open(p_team uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_conversation private.assistant_conversations;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT409';
  end if;
  if p_team is null or not private.can(p_team, 'edit', v_user) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  if not private.assistant_enabled_for(p_team) then
    return jsonb_build_object('enabled', false, 'credits', private.ai_credits_snapshot(v_user));
  end if;
  perform private.assistant_conversation_expire();
  insert into private.assistant_conversations (team_id, user_id) values (p_team, v_user)
  on conflict (team_id, user_id) do update set last_active_at = private.assistant_conversations.last_active_at
  returning * into v_conversation;
  return jsonb_build_object(
    'enabled', true,
    'conversationId', v_conversation.id,
    'canSaveDefaults', private.can(p_team, 'manage_metadata', v_user),
    'credits', private.ai_credits_snapshot(v_user),
    'messages', coalesce((
      select jsonb_agg(private.assistant_message_json(m) order by m.id)
      from (
        select * from private.assistant_messages x
        where x.conversation_id = v_conversation.id
        order by x.id desc limit 50
      ) m
    ), '[]'::jsonb)
  );
end;
$$;

-- Which of these launches the assistant made (the «з помічника» mark). Anyone who may view.
create function public.assistant_launch_marks(p_team uuid, p_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  if coalesce(cardinality(p_ids), 0) > 500 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  return coalesce((
    select array_agg(l.id) from public.team_launches l
    where l.team_id = p_team and l.id = any (p_ids) and l.created_via = 'assistant'
  ), '{}');
end;
$$;

-- «Запустити N»: the review card the person pressed is tied to the batch the web submits next.
-- The batch itself (053) checks every row's version; this only records which card launched which
-- batch, once.
create function public.assistant_review_launched(p_card uuid, p_batch_key uuid)
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
     or not private.can(v_conversation.team_id, 'edit', auth.uid()) or v_card.kind <> 'review' then
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

-- ---------------------------------------------------------------------------------------------
-- Service functions for the assistant edge function (it passes the authenticated user's id)

create function public.service_assistant_context(p_user uuid, p_team uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conversation uuid;
  v_settings private.ai_settings;
begin
  if p_user is null or p_team is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  if not private.can(p_team, 'edit', p_user) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  select * into v_settings from private.ai_settings s where s.id;
  if not private.assistant_enabled_for(p_team) then
    raise exception 'ASSISTANT_DISABLED' using errcode = 'PT409';
  end if;
  perform private.assistant_conversation_expire();
  insert into private.assistant_conversations (team_id, user_id) values (p_team, p_user)
  on conflict (team_id, user_id) do update set last_active_at = now()
  returning id into v_conversation;
  return jsonb_build_object(
    'conversationId', v_conversation,
    'canSaveDefaults', private.can(p_team, 'manage_metadata', p_user),
    'creditUsd', v_settings.credit_usd,
    'priceVersion', v_settings.price_version
  );
end;
$$;

-- Starts (or replays) one command. Same key and same request: the stored command comes back with
-- its reply; same key, other request: KEY_REUSED.
create function public.service_assistant_begin(
  p_user uuid,
  p_team uuid,
  p_client_key text,
  p_request_hash text,
  p_kind text,
  p_text text,
  p_price integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conversation uuid;
  v_prior private.assistant_commands;
  v_id uuid;
begin
  select c.id into v_conversation from private.assistant_conversations c
  where c.team_id = p_team and c.user_id = p_user;
  if v_conversation is null or not private.can(p_team, 'edit', p_user) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('assistant:' || p_user::text || ':' || p_client_key, 0));
  select * into v_prior from private.assistant_commands c where c.user_id = p_user and c.client_key = p_client_key;
  if found then
    if v_prior.request_hash <> p_request_hash then
      raise exception 'KEY_REUSED' using errcode = 'PT409';
    end if;
    return jsonb_build_object(
      'commandId', v_prior.id, 'replayed', true, 'status', v_prior.status,
      'reply', (select private.assistant_message_json(m) from private.assistant_messages m
                where m.command_id = v_prior.id and m.role = 'assistant' order by m.id desc limit 1)
    );
  end if;
  insert into private.assistant_commands (conversation_id, user_id, team_id, client_key, request_hash, kind, price)
  values (v_conversation, p_user, p_team, p_client_key, p_request_hash, p_kind, coalesce(p_price, 0))
  returning id into v_id;
  if p_text is not null and btrim(p_text) <> '' then
    insert into private.assistant_messages (conversation_id, command_id, role, text, price)
    values (v_conversation, v_id, 'user', left(p_text, 4000), coalesce(p_price, 0));
  end if;
  update private.assistant_conversations set last_active_at = now() where id = v_conversation;
  return jsonb_build_object('commandId', v_id, 'replayed', false, 'status', 'accepted', 'reply', null);
end;
$$;

create function public.service_assistant_status(p_command uuid, p_status text, p_reason text, p_model text, p_plan jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.assistant_commands
  set status = coalesce(p_status, status),
      reason_code = coalesce(p_reason, reason_code),
      model = coalesce(p_model, model),
      plan = coalesce(p_plan, plan),
      updated_at = now()
  where id = p_command;
$$;

-- Writes the assistant's reply: its text and the cards the server built. Returns the message.
create function public.service_assistant_reply(p_command uuid, p_text text, p_cards jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command private.assistant_commands;
  v_ids uuid[] := '{}';
  v_card jsonb;
  v_id uuid;
  v_message private.assistant_messages;
begin
  select * into v_command from private.assistant_commands c where c.id = p_command;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if jsonb_typeof(coalesce(p_cards, '[]')) <> 'array' or jsonb_array_length(coalesce(p_cards, '[]')) > 10 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  for v_card in select value from jsonb_array_elements(coalesce(p_cards, '[]')) loop
    insert into private.assistant_cards (conversation_id, command_id, kind, payload)
    values (v_command.conversation_id, p_command, v_card ->> 'kind', coalesce(v_card -> 'payload', '{}'))
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  insert into private.assistant_messages (conversation_id, command_id, role, text, card_ids)
  values (v_command.conversation_id, p_command, 'assistant', left(coalesce(p_text, ''), 4000), v_ids)
  returning * into v_message;
  return private.assistant_message_json(v_message);
end;
$$;

-- A card of the caller's own conversation in the given space, or null (unknown and foreign look
-- the same).
create function public.service_assistant_card(p_user uuid, p_team uuid, p_card uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.assistant_card_json(c)
  from private.assistant_cards c
  join private.assistant_conversations v on v.id = c.conversation_id
  where c.id = p_card and v.user_id = p_user and v.team_id = p_team
    and private.can(p_team, 'edit', p_user);
$$;

-- Moves a card from an expected state; false when it was not in that state any more.
create function public.service_assistant_card_state(p_card uuid, p_from text, p_to text, p_patch jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.assistant_cards
  set state = p_to, payload = payload || coalesce(p_patch, '{}'), updated_at = now()
  where id = p_card and state = p_from;
  return found;
end;
$$;

create function public.service_assistant_effect(
  p_command uuid, p_step integer, p_row_key text, p_kind text, p_launch uuid, p_offer uuid,
  p_version_before text, p_version_after text, p_fields jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.assistant_command_effects (
    command_id, step, row_key, kind, team_id, launch_id, offer_id, version_before, version_after, fields
  )
  select p_command, p_step, p_row_key, p_kind, c.team_id, p_launch, p_offer, p_version_before,
    p_version_after, coalesce(p_fields, '[]')
  from private.assistant_commands c where c.id = p_command
  on conflict (command_id, step, row_key) do update
  set version_after = excluded.version_after, fields = excluded.fields;
  update public.team_launches
  set created_via = 'assistant', assistant_command_id = p_command
  where p_kind = 'draft_created' and id = p_launch and created_via is null;
$$;

create function public.service_assistant_effects(p_user uuid, p_command uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'commandId', c.id, 'teamId', c.team_id, 'status', c.status,
    'effects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step', e.step, 'rowKey', e.row_key, 'kind', e.kind, 'launchId', e.launch_id,
        'offerId', e.offer_id, 'versionBefore', e.version_before, 'versionAfter', e.version_after,
        'fields', e.fields, 'undone', e.undone_at is not null
      ) order by e.step, e.row_key)
      from private.assistant_command_effects e where e.command_id = c.id
    ), '[]'::jsonb)
  )
  from private.assistant_commands c
  where c.id = p_command and c.user_id = p_user and private.can(c.team_id, 'edit', p_user);
$$;

create function public.service_assistant_effect_undone(p_command uuid, p_step integer, p_row_key text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.assistant_command_effects set undone_at = coalesce(undone_at, now())
  where command_id = p_command and step = p_step and row_key = p_row_key;
$$;

create function public.service_assistant_put_urls(p_command uuid, p_urls text[])
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.assistant_url_slots (command_id, slot, value)
  select p_command, u.ordinality::integer, left(u.value, 8192)
  from unnest(p_urls) with ordinality as u (value, ordinality)
  where u.ordinality <= 50
  on conflict (command_id, slot) do nothing;
$$;

create function public.service_assistant_urls(p_command uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(s.value order by s.slot), '{}')
  from private.assistant_url_slots s where s.command_id = p_command;
$$;

-- ---------------------------------------------------------------------------------------------
-- Offer defaults by mask (T008): only the named paths change; everything else is carried over from
-- the stored profile, so a parallel edit of another field survives. A named path whose stored
-- value is no longer what the person saw is EDIT_CONFLICT. Runs with the caller's rights
-- (manage_metadata) through the existing profile writer.

create function public.save_launch_offer_defaults_masked(
  p_team uuid,
  p_offer uuid,
  p_mask text[],
  p_before jsonb,
  p_values jsonb,
  p_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.team_launch_offer_defaults;
  v_config jsonb;
  v_sub jsonb;
  v_path text;
  v_parts text[];
  v_target text;
  v_seen jsonb;
  v_current jsonb;
  v_next jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_payload jsonb := jsonb_build_array(p_offer, p_mask, p_before, p_values);
begin
  perform private.launch_access(p_team, 'manage_metadata');
  if p_offer is null or coalesce(cardinality(p_mask), 0) = 0 or cardinality(p_mask) > 20
     or jsonb_typeof(p_before) is distinct from 'object' or jsonb_typeof(p_values) is distinct from 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_replay := private.launch_request(p_team, p_key, 'offer-defaults-masked', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text || 'launch-defaults' || p_offer::text, 0));
  select * into v_row from public.team_launch_offer_defaults d where d.team_id = p_team and d.offer_id = p_offer;
  v_config := coalesce(v_row.config, '{}'::jsonb);
  v_sub := coalesce(v_row.sub_config, '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}'::jsonb);
  foreach v_path in array p_mask loop
    v_parts := string_to_array(v_path, '.');
    if cardinality(v_parts) not between 1 and 2 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    v_target := v_parts[1];
    if v_target = 'subConfig' then
      if cardinality(v_parts) <> 2 or v_parts[2] not in ('sub1', 'sub2', 'sub3') then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      v_current := v_sub -> v_parts[2];
    elsif cardinality(v_parts) = 2 then
      if v_target <> 'catalog' then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      v_current := v_config -> 'catalog' -> v_parts[2];
    else
      v_current := v_config -> v_target;
    end if;
    v_seen := p_before -> v_path;
    if v_current is distinct from v_seen then
      raise exception 'EDIT_CONFLICT' using errcode = 'PT409',
        detail = jsonb_build_object('path', v_path)::text;
    end if;
    v_next := p_values -> v_path;
    if v_target = 'subConfig' then
      v_sub := jsonb_set(v_sub, array[v_parts[2]], coalesce(v_next, '[]'::jsonb), true);
    elsif cardinality(v_parts) = 2 then
      v_config := jsonb_set(v_config, '{catalog}', coalesce(v_config -> 'catalog', '{}'::jsonb), true);
      v_config := case when v_next is null then v_config #- array['catalog', v_parts[2]]
                       else jsonb_set(v_config, array['catalog', v_parts[2]], v_next, true) end;
    else
      v_config := case when v_next is null then v_config - v_target
                       else jsonb_set(v_config, array[v_target], v_next, true) end;
    end if;
  end loop;
  v_result := private.save_launch_defaults(
    p_team, p_offer, v_row.version::text, left(p_key, 190) || '-m', v_config, v_sub
  );
  perform private.launch_remember(p_team, p_key, 'offer-defaults-masked', v_payload, v_result);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Pilot administration

create function public.admin_ai_assistant_spaces()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_ai_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'teamId', t.id, 'name', t.name, 'pilot', p.team_id is not null
    ) order by (p.team_id is null), t.name)
    from public.teams t
    left join private.ai_space_pilot p on p.team_id = t.id
    where t.status = 'active'
  ), '[]'::jsonb);
end;
$$;

create function public.admin_ai_set_assistant_space(p_team uuid, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_ai_admin();
  v_before boolean;
begin
  if p_team is null or p_enabled is null or not exists (select 1 from public.teams t where t.id = p_team) then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  v_before := exists (select 1 from private.ai_space_pilot p where p.team_id = p_team);
  if p_enabled then
    insert into private.ai_space_pilot (team_id, enabled_by) values (p_team, v_actor) on conflict do nothing;
  else
    delete from private.ai_space_pilot where team_id = p_team;
  end if;
  insert into private.ai_admin_events (actor_id, kind, subject_id, before, after)
  values (v_actor, 'assistant_space', p_team, to_jsonb(v_before), to_jsonb(p_enabled));
  return public.admin_ai_assistant_spaces();
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants

revoke all on function private.assistant_enabled_for(uuid) from public, anon, authenticated;
revoke all on function private.assistant_conversation_expire() from public, anon, authenticated;
revoke all on function private.assistant_card_json(private.assistant_cards) from public, anon, authenticated;
revoke all on function private.assistant_message_json(private.assistant_messages) from public, anon, authenticated;
revoke all on function public.assistant_open(uuid) from public, anon;
revoke all on function public.assistant_launch_marks(uuid, uuid[]) from public, anon;
revoke all on function public.assistant_review_launched(uuid, uuid) from public, anon;
revoke all on function public.save_launch_offer_defaults_masked(uuid, uuid, text[], jsonb, jsonb, text) from public, anon;
revoke all on function public.admin_ai_assistant_spaces() from public, anon;
revoke all on function public.admin_ai_set_assistant_space(uuid, boolean) from public, anon;
revoke all on function public.service_assistant_context(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_assistant_begin(uuid, uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.service_assistant_status(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.service_assistant_reply(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.service_assistant_card(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_assistant_card_state(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.service_assistant_effect(uuid, integer, text, text, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.service_assistant_effects(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_assistant_effect_undone(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.service_assistant_put_urls(uuid, text[]) from public, anon, authenticated;
revoke all on function public.service_assistant_urls(uuid) from public, anon, authenticated;

grant execute on function public.assistant_open(uuid) to authenticated;
grant execute on function public.assistant_launch_marks(uuid, uuid[]) to authenticated;
grant execute on function public.assistant_review_launched(uuid, uuid) to authenticated;
grant execute on function public.save_launch_offer_defaults_masked(uuid, uuid, text[], jsonb, jsonb, text) to authenticated;
grant execute on function public.admin_ai_assistant_spaces() to authenticated;
grant execute on function public.admin_ai_set_assistant_space(uuid, boolean) to authenticated;
grant execute on function public.service_assistant_context(uuid, uuid) to service_role;
grant execute on function public.service_assistant_begin(uuid, uuid, text, text, text, text, integer) to service_role;
grant execute on function public.service_assistant_status(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.service_assistant_reply(uuid, text, jsonb) to service_role;
grant execute on function public.service_assistant_card(uuid, uuid, uuid) to service_role;
grant execute on function public.service_assistant_card_state(uuid, text, text, jsonb) to service_role;
grant execute on function public.service_assistant_effect(uuid, integer, text, text, uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.service_assistant_effects(uuid, uuid) to service_role;
grant execute on function public.service_assistant_effect_undone(uuid, integer, text) to service_role;
grant execute on function public.service_assistant_put_urls(uuid, text[]) to service_role;
grant execute on function public.service_assistant_urls(uuid) to service_role;
