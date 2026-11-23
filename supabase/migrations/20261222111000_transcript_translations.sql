-- 063: translations of finished transcripts, made by the transcript-translate function.
--
-- Two scopes share one table:
--   team_video — a video in a space; everyone who may view the space sees its translations, and
--                the person who started one pays for it from their own daily allowance;
--   personal   — a text of the local transcriber, owned by one account and visible to it alone,
--                found again by the transcriber job id or, on another computer, by the text itself.
-- A translation is tied to the exact text it was made from (source_fingerprint, "v1:" + SHA-256 of
-- the normalized segments). When the transcript changes the old translation stays readable and is
-- shown as made from an earlier text until a new one replaces it.
--
-- This does not revive 046's library translations: those rows keep their fences and stay hidden.

create table private.transcript_translations (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('team_video', 'personal')),
  team_id uuid references public.teams (id) on delete cascade,
  video_id uuid references public.team_materials (id) on delete cascade,
  owner_id uuid references auth.users (id) on delete cascade,
  document_key text check (document_key ~ '^[A-Za-z0-9_-]{1,80}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^v1:[0-9a-f]{64}$'),
  source_language text check (source_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  target_language text not null check (target_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  failure_code text check (failure_code in (
    'TRANSLATION_REFUSED', 'TRANSLATION_UNAVAILABLE', 'TRANSLATION_FAILED', 'TRANSLATION_TIMEOUT'
  )),
  segments text[],
  total_segments integer not null check (total_segments between 1 and 4000),
  completed_segments integer not null default 0,
  units integer not null check (units > 0),
  model text check (model ~ '^claude-[a-z0-9-]{3,40}$'),
  reservation_id uuid references private.ai_allowance_reservations (id) on delete set null,
  requested_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((scope = 'team_video') = (team_id is not null and video_id is not null)),
  check ((scope = 'personal') = (owner_id is not null and document_key is not null)),
  check (completed_segments between 0 and total_segments),
  check ((status = 'failed') = (failure_code is not null)),
  check ((status = 'completed') = (segments is not null)),
  check (segments is null or cardinality(segments) = total_segments)
);

-- One attempt in flight and one finished result per text, target and scope; the expression is the
-- scope's own key (the video, or the owner's transcriber document).
create unique index transcript_translations_one_processing
  on private.transcript_translations (
    (coalesce(video_id::text, owner_id::text || ':' || document_key)), target_language, source_fingerprint
  ) where status = 'processing';
create unique index transcript_translations_one_completed
  on private.transcript_translations (
    (coalesce(video_id::text, owner_id::text || ':' || document_key)), target_language, source_fingerprint
  ) where status = 'completed';
create index transcript_translations_video on private.transcript_translations (team_id, video_id);
create index transcript_translations_document on private.transcript_translations (owner_id, document_key);
create index transcript_translations_owner_text on private.transcript_translations (owner_id, source_fingerprint);

alter table private.transcript_translations enable row level security;
alter table private.transcript_translations force row level security;
revoke all on table private.transcript_translations from public, anon, authenticated, service_role;

-- A foreign key to team_materials puts the table in the attachment-cleanup inventory; without the
-- fence the cleanup coverage check turns false and attachment cleanup stops for the whole base.
create trigger task_cleanup_reference_fence before insert or update on private.transcript_translations
  for each row execute function private.guard_task_cleanup_reference();

-- An attempt older than this is over, whatever state it was left in. The function stops itself at
-- four minutes; the allowance stops counting a held reservation at six.
create function private.transcript_translation_stale_after()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 minutes' $$;

create function private.transcript_translation_json(r private.transcript_translations, p_with_segments boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'scope', r.scope,
    'targetLanguage', r.target_language,
    'sourceLanguage', r.source_language,
    'sourceFingerprint', r.source_fingerprint,
    'status', r.status,
    'failureCode', r.failure_code,
    'segments', case when p_with_segments and r.status = 'completed' then to_jsonb(r.segments) else 'null'::jsonb end,
    'totalSegments', r.total_segments,
    'completedSegments', r.completed_segments,
    'units', r.units,
    'model', r.model,
    'createdAt', r.created_at,
    'completedAt', r.completed_at
  );
$$;

-- Closes attempts that outlived the stale window and gives their allowance back. Called by every
-- reader and by begin, so nothing waits for a scheduler and nothing stays "translating" forever.
create function private.transcript_translation_expire(p_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare r record;
begin
  for r in
    update private.transcript_translations t
    set status = 'failed', failure_code = 'TRANSLATION_TIMEOUT', updated_at = now()
    where t.id = any(p_ids)
      and t.status = 'processing'
      and t.created_at < now() - private.transcript_translation_stale_after()
    returning t.reservation_id
  loop
    if r.reservation_id is not null then
      perform public.service_ai_allowance_settle(r.reservation_id, false);
    end if;
  end loop;
end;
$$;

create function public.service_transcript_translation_begin(
  p_scope text,
  p_team uuid,
  p_video uuid,
  p_owner uuid,
  p_document_key text,
  p_fingerprint text,
  p_source_language text,
  p_target_language text,
  p_total_segments integer,
  p_units integer,
  p_requested_by uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing private.transcript_translations;
  v_reservation uuid;
  v_id uuid;
  v_key text := coalesce(p_video::text, p_owner::text || ':' || p_document_key);
begin
  if p_requested_by is null or p_units is null or p_units <= 0 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  -- One person's translations of one text into one language start one at a time.
  perform pg_advisory_xact_lock(hashtextextended(
    'transcript_translation:' || v_key || ':' || p_target_language || ':' || p_fingerprint, 0
  ));
  perform private.transcript_translation_expire(array(
    select t.id from private.transcript_translations t
    where coalesce(t.video_id::text, t.owner_id::text || ':' || t.document_key) = v_key
      and t.status = 'processing'
  ));
  -- Failed attempts are history only for a week.
  delete from private.transcript_translations t
  where coalesce(t.video_id::text, t.owner_id::text || ':' || t.document_key) = v_key
    and t.status = 'failed'
    and t.updated_at < now() - interval '7 days';

  select * into v_existing from private.transcript_translations t
  where coalesce(t.video_id::text, t.owner_id::text || ':' || t.document_key) = v_key
    and t.target_language = p_target_language
    and t.source_fingerprint = p_fingerprint
    and t.status in ('processing', 'completed')
  order by (t.status = 'completed') desc, t.created_at desc
  limit 1;
  if found then
    return jsonb_build_object(
      'id', v_existing.id,
      'status', v_existing.status,
      'reused', true,
      'allowance', private.ai_allowance_snapshot(p_requested_by, 'transcript_translation')
    );
  end if;

  v_reservation := public.service_ai_allowance_reserve(p_requested_by, 'transcript_translation', p_units);
  insert into private.transcript_translations (
    scope, team_id, video_id, owner_id, document_key, source_fingerprint, source_language,
    target_language, total_segments, units, reservation_id, requested_by
  ) values (
    p_scope, p_team, p_video, p_owner, p_document_key, p_fingerprint, p_source_language,
    p_target_language, p_total_segments, p_units, v_reservation, p_requested_by
  ) returning id into v_id;
  return jsonb_build_object(
    'id', v_id,
    'status', 'processing',
    'reused', false,
    'allowance', private.ai_allowance_snapshot(p_requested_by, 'transcript_translation')
  );
end;
$$;

create function public.service_transcript_translation_progress(p_id uuid, p_completed integer)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.transcript_translations
  set completed_segments = least(total_segments, greatest(completed_segments, p_completed)),
      updated_at = now()
  where id = p_id and status = 'processing';
$$;

create function public.service_transcript_translation_complete(p_id uuid, p_segments text[], p_model text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare r private.transcript_translations;
begin
  select * into r from private.transcript_translations where id = p_id for update;
  if not found or r.status <> 'processing' then
    return;
  end if;
  if p_segments is null or cardinality(p_segments) <> r.total_segments then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  -- An older result for the same scope and language is replaced, not kept beside the new one.
  delete from private.transcript_translations t
  where coalesce(t.video_id::text, t.owner_id::text || ':' || t.document_key)
        = coalesce(r.video_id::text, r.owner_id::text || ':' || r.document_key)
    and t.target_language = r.target_language
    and t.status = 'completed'
    and t.id <> r.id;
  update private.transcript_translations
  set status = 'completed', segments = p_segments, completed_segments = total_segments,
      model = p_model, updated_at = now(), completed_at = now()
  where id = p_id;
  if r.reservation_id is not null then
    perform public.service_ai_allowance_settle(r.reservation_id, true);
  end if;
end;
$$;

create function public.service_transcript_translation_fail(p_id uuid, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_reservation uuid;
begin
  update private.transcript_translations
  set status = 'failed', failure_code = p_code, updated_at = now()
  where id = p_id and status = 'processing'
  returning reservation_id into v_reservation;
  if v_reservation is not null then
    perform public.service_ai_allowance_settle(v_reservation, false);
  end if;
end;
$$;

-- The rows a viewer of one scope should see: per language the newest finished result, every
-- attempt in flight, and the viewer's own most recent failure when it is newer than both.
create function private.transcript_translation_visible(p_rows private.transcript_translations[], p_viewer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ranked as (
    select r.id, r.status, r.requested_by, r.created_at,
      row_number() over (partition by r.target_language, r.status order by r.created_at desc) as rank,
      max(r.created_at) filter (where r.status <> 'failed') over (partition by r.target_language) as latest_live
    from unnest(p_rows) r
  ),
  visible as (
    select id from ranked
    where (status = 'completed' and rank = 1)
       or status = 'processing'
       or (status = 'failed' and rank = 1 and requested_by = p_viewer
           and (latest_live is null or created_at > latest_live))
  )
  select jsonb_build_object('translations', coalesce(
    jsonb_agg(private.transcript_translation_json(x, true) order by x.created_at),
    '[]'::jsonb
  ))
  from unnest(p_rows) x
  where x.id in (select id from visible);
$$;

create function public.list_video_translations(p_team uuid, p_video uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_rows private.transcript_translations[];
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT409';
  end if;
  if not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  perform private.transcript_translation_expire(array(
    select t.id from private.transcript_translations t
    where t.team_id = p_team and t.video_id = p_video and t.status = 'processing'
  ));
  select coalesce(array_agg(t), '{}') into v_rows
  from private.transcript_translations t
  where t.scope = 'team_video' and t.team_id = p_team and t.video_id = p_video;
  return private.transcript_translation_visible(v_rows, auth.uid());
end;
$$;

create function public.list_personal_translations(p_document_key text, p_fingerprint text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_rows private.transcript_translations[];
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT409';
  end if;
  perform private.transcript_translation_expire(array(
    select t.id from private.transcript_translations t
    where t.owner_id = auth.uid() and t.status = 'processing'
      and (t.document_key = p_document_key or t.source_fingerprint = p_fingerprint)
  ));
  select coalesce(array_agg(t), '{}') into v_rows
  from private.transcript_translations t
  where t.scope = 'personal' and t.owner_id = auth.uid()
    and (t.document_key = p_document_key or t.source_fingerprint = p_fingerprint);
  return private.transcript_translation_visible(v_rows, auth.uid());
end;
$$;

create function public.get_transcript_translation(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare r private.transcript_translations;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT409';
  end if;
  perform private.transcript_translation_expire(array[p_id]);
  select * into r from private.transcript_translations where id = p_id;
  if not found
     or (r.scope = 'team_video' and not private.can(r.team_id, 'view', auth.uid()))
     or (r.scope = 'personal' and r.owner_id <> auth.uid()) then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  return private.transcript_translation_json(r, true);
end;
$$;

revoke all on function private.transcript_translation_stale_after() from public, anon, authenticated;
revoke all on function private.transcript_translation_json(private.transcript_translations, boolean) from public, anon, authenticated;
revoke all on function private.transcript_translation_expire(uuid[]) from public, anon, authenticated;
revoke all on function public.service_transcript_translation_begin(text, uuid, uuid, uuid, text, text, text, text, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.service_transcript_translation_progress(uuid, integer) from public, anon, authenticated;
revoke all on function public.service_transcript_translation_complete(uuid, text[], text) from public, anon, authenticated;
revoke all on function public.service_transcript_translation_fail(uuid, text) from public, anon, authenticated;
revoke all on function private.transcript_translation_visible(private.transcript_translations[], uuid) from public, anon, authenticated;
revoke all on function public.list_video_translations(uuid, uuid) from public, anon;
revoke all on function public.list_personal_translations(text, text) from public, anon;
revoke all on function public.get_transcript_translation(uuid) from public, anon;

grant execute on function public.list_video_translations(uuid, uuid) to authenticated;
grant execute on function public.list_personal_translations(text, text) to authenticated;
grant execute on function public.get_transcript_translation(uuid) to authenticated;
grant execute on function public.service_transcript_translation_begin(text, uuid, uuid, uuid, text, text, text, text, integer, integer, uuid) to service_role;
grant execute on function public.service_transcript_translation_progress(uuid, integer) to service_role;
grant execute on function public.service_transcript_translation_complete(uuid, text[], text) to service_role;
grant execute on function public.service_transcript_translation_fail(uuid, text) to service_role;
