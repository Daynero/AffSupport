-- 063: deleting a translation (owner, 2026-11-21: "не вистачає видалити").
--
-- One call removes a language from a text: every finished or failed attempt of that language
-- for the same video (or the same transcriber document of the same owner). An attempt still
-- running is left alone — it finishes and is shown again; deleting it mid-flight would leave
-- the function writing into a row that no longer exists.
--
-- Who may delete: in a space, the person who made the translation or anyone allowed to edit
-- the space; in the transcriber, only its owner. Spent allowance is not given back: the model
-- already did the work.

create function public.delete_transcript_translation(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r private.transcript_translations;
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT409';
  end if;
  select * into r from private.transcript_translations where id = p_id;
  if not found
     or (r.scope = 'team_video' and not private.can(r.team_id, 'view', auth.uid()))
     or (r.scope = 'personal' and r.owner_id <> auth.uid()) then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  if r.scope = 'team_video'
     and r.requested_by <> auth.uid()
     and not private.can(r.team_id, 'edit', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  delete from private.transcript_translations t
  where coalesce(t.video_id::text, t.owner_id::text || ':' || t.document_key)
        = coalesce(r.video_id::text, r.owner_id::text || ':' || r.document_key)
    and t.target_language = r.target_language
    and t.status <> 'processing';
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted, 'targetLanguage', r.target_language);
end;
$$;

revoke all on function public.delete_transcript_translation(uuid) from public, anon;
grant execute on function public.delete_transcript_translation(uuid) to authenticated;
