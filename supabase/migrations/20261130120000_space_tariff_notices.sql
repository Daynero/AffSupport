-- Feature 034 — tariff letters (plan R9, US5, FR-008).
--
-- An hourly queue writes only the letter that is current for a tariff's present end date
-- (three days, one day, the extra days, suspended); one row per (tariff, kind, end date), so a
-- letter is never sent twice for the same term, an extension makes the old term's unsent
-- letters `superseded`, and a late run sends the current letter only. Grant and renewal letters
-- are queued by the admin RPCs; a member's reminder by `request_space_owner_nudge`.
-- The edge function `tariff-notices` claims, sends through Resend and finishes each row; it is
-- woken through pg_net with the catalog-sync secret, at a URL derived from the catalog-sync URL,
-- so no new secret exists. Internal spaces and spaces held by the legacy rule get no letters.
-- Forward-only; reverse steps in ROLLBACK.md.

-- The warning that is current for a state, or null.
create function private.tariff_notice_kind(p_state text, p_days_left integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_state = 'expiring' and p_days_left >= 2 then 'warn_3d'
    when p_state = 'expiring' then 'warn_1d'
    when p_state = 'grace' then 'grace'
    when p_state = 'blocked' then 'blocked'
  end;
$$;

revoke all on function private.tariff_notice_kind(text, integer) from public, anon, authenticated;

create function private.queue_tariff_notices(p_at timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  tariff public.space_tariffs%rowtype;
  st record;
  wanted text;
  queued integer := 0;
  inserted integer;
begin
  for tariff in
    select candidate.*
    from public.space_tariffs as candidate
    where candidate.team_id is not null
      and (candidate.revoked_at is null or candidate.revoked_at > p_at - interval '7 days')
      and candidate.ends_on >= private.kyiv_today(p_at) - 10
  loop
    select * into st from private.space_tariff_state(tariff.team_id, p_at);
    wanted := null;
    if st.tariff_id = tariff.id then
      wanted := private.tariff_notice_kind(st.state, st.days_left);
      -- A suspension letter only for a recent one: nothing is announced weeks late.
      if wanted = 'blocked' and not (
           (tariff.revoked_at is not null and tariff.revoked_at > p_at - interval '7 days')
           or (tariff.revoked_at is null and st.grace_until > p_at - interval '7 days')
         ) then
        wanted := null;
      end if;
    end if;

    update public.space_tariff_notices as notice
       set state = 'superseded', lease_until = null, updated_at = clock_timestamp()
     where notice.tariff_id = tariff.id
       and notice.state = 'pending'
       and notice.kind in ('warn_3d', 'warn_1d', 'grace', 'blocked')
       and not (wanted is not null and notice.kind = wanted and notice.period_end = tariff.ends_on);

    if wanted is not null then
      insert into public.space_tariff_notices (tariff_id, kind, period_end)
      values (tariff.id, wanted, tariff.ends_on)
      on conflict (tariff_id, kind, period_end) do nothing;
      get diagnostics inserted = row_count;
      queued := queued + inserted;
    end if;
  end loop;
  return queued;
end;
$$;

revoke all on function private.queue_tariff_notices(timestamptz) from public, anon, authenticated;

-- Is the letter still true now? A warning must match the tariff's current end date and state; a
-- grant or renewal its live end date; a member's reminder a space that is still suspended.
create function private.tariff_notice_still_due(p_notice public.space_tariff_notices)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tariff public.space_tariffs%rowtype;
  st record;
begin
  select * into tariff from public.space_tariffs where id = p_notice.tariff_id;
  if tariff.id is null then
    return false;
  end if;
  if p_notice.kind = 'member_nudge' then
    return tariff.team_id is not null
      and not private.team_workspace_allowed(tariff.team_id)
      and (select state.tariff_id from private.space_tariff_state(tariff.team_id, now()) as state) = tariff.id;
  end if;
  if p_notice.kind in ('granted', 'renewed') then
    if tariff.revoked_at is not null or tariff.ends_on <> p_notice.period_end then
      return false;
    end if;
    if tariff.team_id is null then
      return true;
    end if;
    select * into st from private.space_tariff_state(tariff.team_id, now());
    return st.state not in ('legacy', 'internal', 'blocked', 'none');
  end if;
  if tariff.team_id is null or tariff.ends_on <> p_notice.period_end then
    return false;
  end if;
  select * into st from private.space_tariff_state(tariff.team_id, now());
  return st.tariff_id = tariff.id
    and private.tariff_notice_kind(st.state, st.days_left) = p_notice.kind;
end;
$$;

revoke all on function private.tariff_notice_still_due(public.space_tariff_notices) from public, anon, authenticated;

-- Five-minute lease per letter; a row that no longer applies becomes `superseded` instead.
create function public.service_claim_tariff_notices(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  notice public.space_tariff_notices%rowtype;
  claimed jsonb := '[]'::jsonb;
  tariff public.space_tariffs%rowtype;
  plan public.tariff_plans%rowtype;
  owner_profile public.profiles%rowtype;
  recipient text;
  team_label text;
  member_label text;
begin
  for notice in
    select candidate.*
    from public.space_tariff_notices as candidate
    where candidate.state = 'pending'
      and candidate.attempts < 3
      and (candidate.lease_until is null or candidate.lease_until <= clock_timestamp())
    order by candidate.created_at, candidate.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update skip locked
  loop
    if not private.tariff_notice_still_due(notice) then
      update public.space_tariff_notices
         set state = 'superseded', lease_until = null, updated_at = clock_timestamp()
       where id = notice.id;
      continue;
    end if;

    update public.space_tariff_notices
       set attempts = attempts + 1,
           lease_until = clock_timestamp() + interval '5 minutes',
           updated_at = clock_timestamp()
     where id = notice.id;

    select * into tariff from public.space_tariffs where id = notice.tariff_id;
    select * into plan from public.tariff_plans where code = tariff.plan_code;
    owner_profile := null;
    select * into owner_profile from public.profiles where id = tariff.owner_id;
    recipient := coalesce(
      (select lower(btrim(users.email)) from auth.users as users where users.id = tariff.owner_id),
      tariff.owner_email::text
    );
    select team.name into team_label from public.teams as team where team.id = tariff.team_id;
    member_label := null;
    if notice.requested_by is not null then
      select profile.display_name into member_label
      from public.profiles as profile where profile.id = notice.requested_by;
    end if;

    claimed := claimed || jsonb_build_array(jsonb_build_object(
      'id', notice.id,
      'kind', notice.kind,
      'tariffId', tariff.id,
      'teamId', tariff.team_id,
      'teamName', team_label,
      'recipientEmail', recipient,
      'recipientName', owner_profile.display_name,
      'locale', case when owner_profile.language = 'en' then 'en' else 'uk' end,
      'planNameUk', plan.name_uk,
      'planNameEn', plan.name_en,
      'endsOn', tariff.ends_on::text,
      'graceUntil', (tariff.ends_on + 3)::text,
      'updaterRunning', case when tariff.team_id is null then false
                             else private.team_updater_running(tariff.team_id) end,
      'contact', private.tariff_contact_json(),
      'memberName', member_label
    ));
  end loop;
  return claimed;
end;
$$;

-- Sent, skipped (beta), or failed: a failure waits out its lease before it is tried again, and
-- the third failure is final.
create function public.service_finish_tariff_notice(
  p_id uuid,
  p_sent boolean,
  p_error text default null,
  p_skipped boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  skipped boolean := coalesce(p_skipped, false);
  sent boolean := coalesce(p_sent, false) and not coalesce(p_skipped, false);
begin
  update public.space_tariff_notices as notice
     set state = case
           when skipped then 'skipped'
           when sent then 'sent'
           when notice.attempts >= 3 then 'failed'
           else 'pending'
         end,
         sent_at = case when sent then clock_timestamp() else notice.sent_at end,
         last_error = case when sent or skipped then notice.last_error
                           else left(coalesce(p_error, 'UNKNOWN'), 500) end,
         lease_until = case when sent or skipped then null
                            else greatest(coalesce(notice.lease_until, clock_timestamp()),
                                          clock_timestamp() + interval '5 minutes') end,
         updated_at = clock_timestamp()
   where notice.id = p_id and notice.state = 'pending';
  return found;
end;
$$;

revoke all on function public.service_claim_tariff_notices(integer) from public, anon, authenticated;
revoke all on function public.service_finish_tariff_notice(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.service_claim_tariff_notices(integer) to service_role;
grant execute on function public.service_finish_tariff_notice(uuid, boolean, text, boolean) to service_role;

-- The edge function's URL, beside catalog-sync (as private.catalog_updater_endpoint does).
create function private.tariff_notices_endpoint(p_catalog_sync_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_catalog_sync_url ~ '^https?://[^[:space:]]+/catalog-sync$'
      then regexp_replace(p_catalog_sync_url, '/catalog-sync$', '/tariff-notices')
  end;
$$;

revoke all on function private.tariff_notices_endpoint(text) from public, anon, authenticated;

create function private.invoke_tariff_notices()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  if not exists (
    select 1 from public.space_tariff_notices as notice
    where notice.state = 'pending' and notice.attempts < 3
      and (notice.lease_until is null or notice.lease_until <= clock_timestamp())
  ) then
    return null;
  end if;

  select private.tariff_notices_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function private.invoke_tariff_notices() from public, anon, authenticated;

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname in ('wishly-tariff-notices-queue', 'wishly-tariff-notices');

select cron.schedule(
  'wishly-tariff-notices-queue',
  '7 * * * *',
  $cron$select private.queue_tariff_notices(now())$cron$
);

select cron.schedule(
  'wishly-tariff-notices',
  '*/10 * * * *',
  $cron$select private.invoke_tariff_notices()$cron$
);
