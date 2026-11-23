-- 064: translation pays in чарунки. The price is computed before the button is pressed
-- (⌈minutes × rate⌉, packages/shared ai-credits.ts), shown on «Перекласти · N» and debited exactly,
-- inside 063's job lock: two people pressing at once get one translation, one model run and one
-- debit — whoever fixed the job pays; the other joins for free. A finished translation settles
-- the month hold at its real cost; a failed or expired one gives the credits back.
--
-- Attempts begun under 063's character allowance keep their reservation and settle it as before.

alter table private.transcript_translations add column credit_op_key text;

create or replace function private.transcript_translation_expire(p_ids uuid[])
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
    returning t.reservation_id, t.credit_op_key, t.requested_by
  loop
    if r.reservation_id is not null then
      perform public.service_ai_allowance_settle(r.reservation_id, false);
    end if;
    if r.credit_op_key is not null then
      perform public.service_ai_credit_refund(r.requested_by, r.credit_op_key);
    end if;
  end loop;
end;
$$;

create function public.service_transcript_translation_begin_credits(
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
  p_requested_by uuid,
  p_price integer,
  p_price_version text,
  p_usd_upper numeric
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing private.transcript_translations;
  v_id uuid := gen_random_uuid();
  v_key text := coalesce(p_video::text, p_owner::text || ':' || p_document_key);
  v_op text;
  v_debit jsonb;
begin
  if p_requested_by is null or p_units is null or p_units <= 0 or p_price is null or p_price <= 0 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  -- One translation of one text into one language starts once, whoever presses.
  perform pg_advisory_xact_lock(hashtextextended(
    'transcript_translation:' || v_key || ':' || p_target_language || ':' || p_fingerprint, 0
  ));
  perform private.transcript_translation_expire(array(
    select t.id from private.transcript_translations t
    where coalesce(t.video_id::text, t.owner_id::text || ':' || t.document_key) = v_key
      and t.status = 'processing'
  ));
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
      'credits', private.ai_credits_snapshot(p_requested_by)
    );
  end if;

  v_op := 'transcript_translation:' || replace(v_id::text, '-', '');
  v_debit := public.service_ai_credit_debit(
    p_requested_by, v_op, 'transcript_translation', p_price, p_price_version, v_id, p_usd_upper
  );
  insert into private.transcript_translations (
    id, scope, team_id, video_id, owner_id, document_key, source_fingerprint, source_language,
    target_language, total_segments, units, credit_op_key, requested_by
  ) values (
    v_id, p_scope, p_team, p_video, p_owner, p_document_key, p_fingerprint, p_source_language,
    p_target_language, p_total_segments, p_units, v_op, p_requested_by
  );
  return jsonb_build_object(
    'id', v_id,
    'status', 'processing',
    'reused', false,
    'opKey', v_op,
    'credits', v_debit -> 'credits'
  );
end;
$$;

create or replace function public.service_transcript_translation_complete(p_id uuid, p_segments text[], p_model text)
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
  if r.credit_op_key is not null then
    perform public.service_ai_credit_settle(r.credit_op_key);
  end if;
end;
$$;

create or replace function public.service_transcript_translation_fail(p_id uuid, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row record;
begin
  update private.transcript_translations
  set status = 'failed', failure_code = p_code, updated_at = now()
  where id = p_id and status = 'processing'
  returning reservation_id, credit_op_key, requested_by into v_row;
  if v_row.reservation_id is not null then
    perform public.service_ai_allowance_settle(v_row.reservation_id, false);
  end if;
  if v_row.credit_op_key is not null then
    perform public.service_ai_credit_refund(v_row.requested_by, v_row.credit_op_key);
  end if;
end;
$$;

revoke all on function public.service_transcript_translation_begin_credits(text, uuid, uuid, uuid, text, text,
  text, text, integer, integer, uuid, integer, text, numeric) from public, anon, authenticated;
grant execute on function public.service_transcript_translation_begin_credits(text, uuid, uuid, uuid, text, text,
  text, text, integer, integer, uuid, integer, text, numeric) to service_role;
