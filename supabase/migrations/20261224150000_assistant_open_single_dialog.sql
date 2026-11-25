-- 070: opening the assistant twice at once made two dialogs. In a fresh browser two concurrent
-- `assistant_open_dialog` calls both found no live dialog and both inserted one with the same
-- time; a message went to one while the window could show the other, empty one.
--
-- Finding or making a person's dialog in a space is now serialised per (space, person) with a
-- transaction-scoped advisory lock. The second caller waits for the first to commit and then sees
-- its dialog (read committed takes a fresh snapshot per statement), so it returns the same one.
-- «Новий діалог» takes the same lock, so two presses in two tabs reuse one empty dialog too.
-- Several dialogs per person stay allowed, so this is a lock rather than a unique constraint.

create or replace function private.assistant_latest_dialog(p_team uuid, p_user uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('assistant-dialog:' || p_team::text || ':' || p_user::text, 0));
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

create or replace function public.assistant_new_dialog(p_team uuid)
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
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('assistant-dialog:' || p_team::text || ':' || v_user::text, 0));
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

revoke all on function private.assistant_latest_dialog(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_new_dialog(uuid) from public, anon;
grant execute on function public.assistant_new_dialog(uuid) to authenticated;
