-- 012 (T011): the per-account answer to "delete the transcript when the video
-- is deleted?" — 'ask' (the default: prompt each time), 'delete' (silently
-- remove the companion too), or 'keep' (leave it). Set from the delete dialog's
-- "don't ask again" checkbox and editable in account settings.

alter table public.profiles
  add column if not exists transcript_delete_pref text not null default 'ask';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_transcript_delete_pref_check'
  ) then
    alter table public.profiles
      add constraint profiles_transcript_delete_pref_check
      check (transcript_delete_pref in ('ask', 'delete', 'keep'));
  end if;
end $$;

create or replace function public.get_transcript_delete_pref()
returns text
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (select profile.transcript_delete_pref from public.profiles as profile
      where profile.id = auth.uid()),
    'ask'
  );
$$;

create or replace function public.set_transcript_delete_pref(p_pref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_pref not in ('ask', 'delete', 'keep') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.profiles as profile
     set transcript_delete_pref = p_pref, updated_at = pg_catalog.clock_timestamp()
   where profile.id = auth.uid();
  return p_pref;
end;
$$;

revoke all on function public.get_transcript_delete_pref() from public, anon;
grant execute on function public.get_transcript_delete_pref() to authenticated;
revoke all on function public.set_transcript_delete_pref(text) from public, anon;
grant execute on function public.set_transcript_delete_pref(text) to authenticated;
