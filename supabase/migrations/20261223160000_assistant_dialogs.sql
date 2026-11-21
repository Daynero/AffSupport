-- 064: several dialogs with the assistant, as in any AI chat. A person keeps a list of their
-- dialogs in a space, opens any of them or starts a new one; each lives seven days after its last
-- activity. The title is the beginning of the first message. Only the author sees a dialog.
--
-- The single-dialog functions keep working for a build that still calls them: they take the
-- person's most recent dialog.

alter table private.assistant_conversations
  drop constraint if exists assistant_conversations_team_id_user_id_key;
alter table private.assistant_conversations add column title text;
create index assistant_conversations_owner
  on private.assistant_conversations (team_id, user_id, last_active_at desc);

-- The person's most recent live dialog in a space, made when there is none.
create function private.assistant_latest_dialog(p_team uuid, p_user uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id from private.assistant_conversations c
  where c.team_id = p_team and c.user_id = p_user
    and c.last_active_at > private.tariff_now() - interval '7 days'
  order by c.last_active_at desc limit 1;
  if v_id is null then
    insert into private.assistant_conversations (team_id, user_id) values (p_team, p_user) returning id into v_id;
  end if;
  return v_id;
end;
$$;

create function private.assistant_dialog_list(p_team uuid, p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'title', c.title, 'lastActiveAt', c.last_active_at,
    'expiresAt', c.last_active_at + interval '7 days'
  ) order by c.last_active_at desc), '[]'::jsonb)
  from (
    select * from private.assistant_conversations x
    where x.team_id = p_team and x.user_id = p_user
      and x.last_active_at > private.tariff_now() - interval '7 days'
    order by x.last_active_at desc limit 30
  ) c;
$$;

create function private.assistant_dialog_json(p_team uuid, p_user uuid, p_dialog uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', true,
    'conversationId', p_dialog,
    'title', (select c.title from private.assistant_conversations c where c.id = p_dialog),
    'canSaveDefaults', private.can(p_team, 'manage_metadata', p_user),
    'credits', private.ai_credits_snapshot(p_user),
    'dialogs', private.assistant_dialog_list(p_team, p_user),
    'messages', coalesce((
      select jsonb_agg(private.assistant_message_json(m) order by m.id)
      from (
        select * from private.assistant_messages x
        where x.conversation_id = p_dialog
        order by x.id desc limit 50
      ) m
    ), '[]'::jsonb)
  );
$$;

-- The browser: one dialog (the given one, else the most recent), with the list of dialogs.
create function public.assistant_open_dialog(p_team uuid, p_dialog uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_dialog uuid := p_dialog;
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
  if v_dialog is not null and not exists (
    select 1 from private.assistant_conversations c
    where c.id = v_dialog and c.team_id = p_team and c.user_id = v_user
  ) then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if v_dialog is null then
    v_dialog := private.assistant_latest_dialog(p_team, v_user);
  end if;
  return private.assistant_dialog_json(p_team, v_user, v_dialog);
end;
$$;

create function public.assistant_new_dialog(p_team uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_dialog uuid;
begin
  if v_user is null or p_team is null or not private.can(p_team, 'edit', v_user) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  if not private.assistant_enabled_for(p_team) then
    raise exception 'ASSISTANT_DISABLED' using errcode = 'PT409';
  end if;
  -- An empty dialog is reused rather than multiplied by repeated presses.
  select c.id into v_dialog from private.assistant_conversations c
  where c.team_id = p_team and c.user_id = v_user and c.title is null
    and not exists (select 1 from private.assistant_messages m where m.conversation_id = c.id)
  order by c.created_at desc limit 1;
  if v_dialog is null then
    insert into private.assistant_conversations (team_id, user_id) values (p_team, v_user) returning id into v_dialog;
  else
    update private.assistant_conversations set last_active_at = now() where id = v_dialog;
  end if;
  return private.assistant_dialog_json(p_team, v_user, v_dialog);
end;
$$;

-- Older single-dialog entry points: the most recent dialog, without the removed constraint.
create or replace function public.assistant_open(p_team uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return public.assistant_open_dialog(p_team, null);
end;
$$;

create function public.service_assistant_context_v2(p_user uuid, p_team uuid, p_dialog uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_dialog uuid := p_dialog;
  v_settings private.ai_settings;
begin
  if p_user is null or p_team is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  if not private.can(p_team, 'edit', p_user) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  if not private.assistant_enabled_for(p_team) then
    raise exception 'ASSISTANT_DISABLED' using errcode = 'PT409';
  end if;
  select * into v_settings from private.ai_settings s where s.id;
  perform private.assistant_conversation_expire();
  if v_dialog is not null and not exists (
    select 1 from private.assistant_conversations c
    where c.id = v_dialog and c.team_id = p_team and c.user_id = p_user
  ) then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if v_dialog is null then
    v_dialog := private.assistant_latest_dialog(p_team, p_user);
  end if;
  update private.assistant_conversations set last_active_at = now() where id = v_dialog;
  return jsonb_build_object(
    'conversationId', v_dialog,
    'canSaveDefaults', private.can(p_team, 'manage_metadata', p_user),
    'creditUsd', v_settings.credit_usd,
    'priceVersion', v_settings.price_version
  );
end;
$$;

create or replace function public.service_assistant_context(p_user uuid, p_team uuid)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.service_assistant_context_v2(p_user, p_team, null);
$$;

-- Starts (or replays) one command in a given dialog; the first message names the dialog.
create function public.service_assistant_begin_v2(
  p_user uuid,
  p_team uuid,
  p_dialog uuid,
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
  v_prior private.assistant_commands;
  v_id uuid;
begin
  if p_dialog is null or not exists (
    select 1 from private.assistant_conversations c
    where c.id = p_dialog and c.team_id = p_team and c.user_id = p_user
  ) or not private.can(p_team, 'edit', p_user) then
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
  values (p_dialog, p_user, p_team, p_client_key, p_request_hash, p_kind, coalesce(p_price, 0))
  returning id into v_id;
  if p_text is not null and btrim(p_text) <> '' then
    insert into private.assistant_messages (conversation_id, command_id, role, text, price)
    values (p_dialog, v_id, 'user', left(p_text, 4000), coalesce(p_price, 0));
    update private.assistant_conversations
    set title = coalesce(title, left(regexp_replace(btrim(p_text), '\s+', ' ', 'g'), 80))
    where id = p_dialog;
  end if;
  update private.assistant_conversations set last_active_at = now() where id = p_dialog;
  return jsonb_build_object('commandId', v_id, 'replayed', false, 'status', 'accepted', 'reply', null);
end;
$$;

-- The older begin: the person's most recent dialog.
create or replace function public.service_assistant_begin(
  p_user uuid,
  p_team uuid,
  p_client_key text,
  p_request_hash text,
  p_kind text,
  p_text text,
  p_price integer
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.service_assistant_begin_v2(
    p_user, p_team, private.assistant_latest_dialog(p_team, p_user), p_client_key, p_request_hash,
    p_kind, p_text, p_price
  );
$$;

revoke all on function private.assistant_latest_dialog(uuid, uuid) from public, anon, authenticated;
revoke all on function private.assistant_dialog_list(uuid, uuid) from public, anon, authenticated;
revoke all on function private.assistant_dialog_json(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_open_dialog(uuid, uuid) from public, anon;
revoke all on function public.assistant_new_dialog(uuid) from public, anon;
revoke all on function public.service_assistant_context_v2(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_assistant_begin_v2(uuid, uuid, uuid, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.assistant_open_dialog(uuid, uuid) to authenticated;
grant execute on function public.assistant_new_dialog(uuid) to authenticated;
grant execute on function public.service_assistant_context_v2(uuid, uuid, uuid) to service_role;
grant execute on function public.service_assistant_begin_v2(uuid, uuid, uuid, text, text, text, text, integer)
  to service_role;
