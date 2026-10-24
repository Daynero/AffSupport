-- 036 seam rollback candidate. Must pass disposable forward/backward verification before use.
-- Restores the observed schema358 definitions; does not delete application rows.
begin;
CREATE OR REPLACE FUNCTION private.kyiv_today(p_at timestamp with time zone DEFAULT now())
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select (p_at at time zone 'Europe/Kyiv')::date;
$function$;

CREATE OR REPLACE FUNCTION private.team_current_tariff(p_team uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS SETOF public.space_tariffs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select tariff.*
  from public.space_tariffs as tariff
  where tariff.team_id = p_team
  order by (tariff.revoked_at is null or tariff.revoked_at > p_at) desc,
           tariff.ends_on desc, tariff.created_at desc
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION private.space_tariff_state(p_team uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(state text, tariff_id uuid, plan_code text, seats_total integer, seats_used integer, ends_on date, ends_at timestamp with time zone, grace_until timestamp with time zone, days_left integer, legacy_also boolean, pending_invites integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  owner uuid;
  tariff public.space_tariffs%rowtype;
  plan_seats integer;
  legacy boolean;
  live boolean := false;
  resolved text;
  remaining integer;
begin
  select team.owner_id into owner
  from public.teams as team where team.id = p_team and team.status = 'active';
  if owner is null then
    return query select 'none'::text, null::uuid, null::text, 0, 0, null::date, null::timestamptz,
                        null::timestamptz, null::integer, false, 0;
    return;
  end if;

  legacy := private.tariff_legacy_rule_enabled() and private.team_legacy_open(p_team);
  select current_tariff.* into tariff from private.team_current_tariff(p_team, p_at) as current_tariff;
  if tariff.id is not null then
    select plan.base_seats + tariff.extra_seats into plan_seats
    from public.tariff_plans as plan where plan.code = tariff.plan_code;
    remaining := tariff.ends_on - private.kyiv_today(p_at);
    live := (tariff.revoked_at is null or tariff.revoked_at > p_at)
      and p_at < private.kyiv_day_end(tariff.ends_on + 3);
  end if;

  if exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = owner) then
    resolved := 'internal';
  elsif live then
    resolved := case when remaining > 3 then 'active' when remaining >= 0 then 'expiring' else 'grace' end;
    -- US2.2: while the legacy rule holds the space, it has no warnings.
    if resolved in ('expiring', 'grace') and legacy then
      resolved := 'legacy';
    end if;
  elsif legacy then
    resolved := 'legacy';
  elsif tariff.id is not null then
    resolved := 'blocked';
  else
    resolved := 'none';
  end if;

  return query select
    resolved,
    tariff.id,
    tariff.plan_code,
    case
      when resolved = 'internal' then 50
      when tariff.id is not null and (live or resolved = 'blocked') then plan_seats
      else 50
    end,
    private.team_seats_used(p_team),
    tariff.ends_on,
    case when tariff.id is not null then private.kyiv_day_end(tariff.ends_on) end,
    case when tariff.id is not null then private.kyiv_day_end(tariff.ends_on + 3) end,
    remaining,
    legacy,
    private.team_pending_invites(p_team);
end;
$function$;

CREATE OR REPLACE FUNCTION private.space_tariff_row_state(p_tariff public.space_tariffs, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(state text, legacy_also boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  st record;
  current_id uuid;
begin
  if p_tariff.team_id is null then
    if p_tariff.revoked_at is not null and p_tariff.revoked_at <= p_at then
      return query select 'blocked'::text, false;
    elsif p_tariff.ends_on >= private.kyiv_today(p_at) then
      return query select 'pending'::text, false;
    else
      return query select 'pending_expired'::text, false;
    end if;
    return;
  end if;
  select * into st from private.space_tariff_state(p_tariff.team_id, p_at);
  if st.tariff_id is distinct from p_tariff.id and st.state <> 'internal' then
    return query select case when st.legacy_also then 'legacy' else 'blocked' end, st.legacy_also;
    return;
  end if;
  return query select st.state, st.legacy_also;
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_tariff_notices(p_at timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.team_workspace_allowed(p_team uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.teams as team
    where team.id = p_team
      and team.status = 'active'
      and (
        exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = team.owner_id)
        or exists (
          select 1 from public.space_tariffs as tariff
          where tariff.team_id = team.id
            and (tariff.revoked_at is null or tariff.revoked_at > now())
            and now() < private.kyiv_day_end(tariff.ends_on + 3)
        )
        or (private.tariff_legacy_rule_enabled() and private.team_legacy_open(team.id))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION private.team_seat_limit(p_team uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when exists (
      select 1 from public.teams as team
      join public.admin_users as owner_admin on owner_admin.user_id = team.owner_id
      where team.id = p_team
    ) then null
    else (
      select plan.base_seats + tariff.extra_seats
      from public.space_tariffs as tariff
      join public.tariff_plans as plan on plan.code = tariff.plan_code
      where tariff.team_id = p_team
        and (tariff.revoked_at is null or tariff.revoked_at > now())
        and now() < private.kyiv_day_end(tariff.ends_on + 3)
      limit 1
    )
  end;
$function$;

CREATE OR REPLACE FUNCTION private.legacy_only_spaces()
 RETURNS TABLE(team_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select team.id
  from public.teams as team
  where team.status = 'active'
    and private.team_legacy_open(team.id)
    and not exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = team.owner_id)
    and not exists (
      select 1 from public.space_tariffs as tariff
      where tariff.team_id = team.id
        and (tariff.revoked_at is null or tariff.revoked_at > now())
        and now() < private.kyiv_day_end(tariff.ends_on + 3)
    );
$function$;

CREATE OR REPLACE FUNCTION private.admin_tariff_row(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  tariff public.space_tariffs%rowtype;
  plan public.tariff_plans%rowtype;
  row_state record;
  owner_label text;
  team_label text;
  used integer := 0;
  invites integer := 0;
begin
  select * into tariff from public.space_tariffs where id = p_id;
  if tariff.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into plan from public.tariff_plans where code = tariff.plan_code;
  select * into row_state from private.space_tariff_row_state(tariff, now());
  select profile.display_name into owner_label from public.profiles as profile where profile.id = tariff.owner_id;
  if tariff.team_id is not null then
    select team.name into team_label from public.teams as team where team.id = tariff.team_id;
    used := private.team_seats_used(tariff.team_id);
    invites := private.team_pending_invites(tariff.team_id);
  end if;
  return jsonb_build_object(
    'id', tariff.id,
    'ownerEmail', tariff.owner_email::text,
    'ownerId', tariff.owner_id,
    'ownerName', owner_label,
    'teamId', tariff.team_id,
    'teamName', team_label,
    'planCode', tariff.plan_code,
    'planNameUk', plan.name_uk,
    'baseSeats', plan.base_seats,
    'extraSeats', tariff.extra_seats,
    'seatsTotal', plan.base_seats + tariff.extra_seats,
    'seatsUsed', used,
    'pendingInvites', invites,
    'startsAt', to_jsonb(tariff.starts_at),
    'endsOn', tariff.ends_on::text,
    'daysLeft', tariff.ends_on - private.kyiv_today(),
    'graceUntil', (tariff.ends_on + 3)::text,
    'revokedAt', to_jsonb(tariff.revoked_at),
    'state', row_state.state,
    'legacyAlso', coalesce(row_state.legacy_also, false),
    'source', tariff.source,
    'externalRef', tariff.external_ref,
    'note', tariff.note,
    'grantedBy', tariff.granted_by,
    'createdAt', to_jsonb(tariff.created_at),
    'updatedAt', to_jsonb(tariff.updated_at)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_space_tariff_letter(p_tariff uuid, p_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  tariff public.space_tariffs%rowtype;
  st text;
begin
  select * into tariff from public.space_tariffs where id = p_tariff;
  if tariff.id is null or tariff.revoked_at is not null then
    return;
  end if;
  if tariff.team_id is not null then
    select state.state into st from private.space_tariff_state(tariff.team_id, now()) as state;
    if st in ('legacy', 'internal') then
      return;
    end if;
  end if;
  insert into public.space_tariff_notices (tariff_id, kind, period_end)
  values (tariff.id, p_kind, tariff.ends_on)
  on conflict (tariff_id, kind, period_end) do nothing;
end;
$function$;

CREATE OR REPLACE FUNCTION private.tariff_notice_still_due(p_notice space_tariff_notices)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.team_tariff_json(p_team uuid, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  st record;
  plan public.tariff_plans%rowtype;
  is_owner boolean;
  seat_limit integer;
begin
  select * into st from private.space_tariff_state(p_team, now());
  select tariff_plan.* into plan from public.tariff_plans as tariff_plan where tariff_plan.code = st.plan_code;
  select team.owner_id = p_user into is_owner from public.teams as team where team.id = p_team;
  is_owner := coalesce(is_owner, false);
  seat_limit := private.team_seat_limit(p_team);
  return jsonb_build_object(
    'state', st.state,
    'planCode', st.plan_code,
    'planNameUk', plan.name_uk,
    'planNameEn', plan.name_en,
    'seatsTotal', st.seats_total,
    'seatsUsed', st.seats_used,
    'pendingInvites', st.pending_invites,
    'canInvite', seat_limit is null or coalesce(plan.invites_allowed, false) or seat_limit > 1,
    'endsOn', case when is_owner then st.ends_on::text end,
    'endsAt', case when is_owner then to_jsonb(st.ends_at) end,
    'graceUntil', case when is_owner then (st.ends_on + 3)::text end,
    'daysLeft', case when is_owner then st.days_left end,
    'isOwner', is_owner,
    'updaterPausedByTariff', exists (
      select 1 from public.team_catalog_updaters as updater
      where updater.team_id = p_team and updater.paused_by_tariff_at is not null
    ),
    'recovery',private.workspace_recovery_json(p_team,p_user)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_space_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  actor_email text;
  admin boolean;
  teams_json jsonb;
  any_allowed boolean;
  any_blocked boolean;
  invitations_json jsonb;
  pending public.space_tariffs%rowtype;
  pending_json jsonb;
  can_create boolean;
  banner_json jsonb;
  toast_json jsonb;
  request_json jsonb;
  mode text;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  perform private.claim_space_tariffs(actor);
  admin := public.is_admin();
  actor_email := coalesce(
    private.team_confirmed_email(actor)::text,
    (select lower(btrim(profile.email)) from public.profiles as profile where profile.id = actor)
  );

  with mine as (
    select team.id, team.name, team.owner_id, team.created_at, member.base_role,
           private.team_workspace_allowed(team.id) as allowed
    from public.team_members as member
    join public.teams as team on team.id = member.team_id and team.status = 'active'
    where member.user_id = actor and member.status = 'active'
  ), described as (
    select mine.*, private.team_tariff_json(mine.id, actor) as tariff
    from mine
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'teamId', described.id,
           'name', described.name,
           'role', case when described.owner_id = actor then 'owner' else described.base_role end,
           'accessState', case when described.allowed then 'allowed' else 'blocked' end,
           'ownerName', (select profile.display_name from public.profiles as profile
                         where profile.id = described.owner_id),
           'tariff', described.tariff
         ) order by described.created_at, described.id), '[]'::jsonb),
         coalesce(bool_or(described.allowed), false),
         coalesce(bool_or(not described.allowed and described.tariff ->> 'state' = 'blocked'), false)
    into teams_json, any_allowed, any_blocked
  from described;

  select coalesce(jsonb_agg(jsonb_build_object(
           'invitationId', invitation.id,
           'teamId', invitation.team_id,
           'teamName', team.name,
           'inviterName', inviter.display_name,
           'role', invitation.initial_role,
           'blocked', not private.team_workspace_allowed(invitation.team_id)
         ) order by invitation.created_at desc, invitation.id), '[]'::jsonb)
    into invitations_json
  from public.team_invitations as invitation
  join public.teams as team on team.id = invitation.team_id and team.status = 'active'
  left join public.profiles as inviter on inviter.id = invitation.inviter_id
  where invitation.state = 'pending'
    and invitation.expires_at > now()
    and (
      invitation.target_user_id = actor
      or (actor_email is not null and lower(invitation.target_email::text) = actor_email)
    )
    and not exists (
      select 1 from public.team_members as member
      where member.team_id = invitation.team_id and member.user_id = actor and member.status = 'active'
    );

  select tariff.* into pending
  from public.space_tariffs as tariff
  where tariff.owner_id = actor
    and tariff.team_id is null
    and tariff.revoked_at is null
    and tariff.ends_on >= private.kyiv_today()
  order by tariff.ends_on, tariff.created_at
  limit 1;
  if pending.id is not null then
    select jsonb_build_object('planCode', plan.code, 'planNameUk', plan.name_uk,
                              'planNameEn', plan.name_en, 'endsOn', pending.ends_on::text)
      into pending_json
    from public.tariff_plans as plan where plan.code = pending.plan_code;
  end if;
  can_create := admin or pending.id is not null;

  -- The owner's nearest warning, never under the legacy rule (the state already says so).
  select jsonb_build_object(
           'teamId', team.id,
           'teamName', team.name,
           'kind', case when st.state = 'grace' then 'grace'
                        when st.days_left <= 1 then 'warn_1d' else 'warn_3d' end,
           'endsOn', st.ends_on::text,
           'graceUntil', (st.ends_on + 3)::text,
           'daysLeft', st.days_left,
           'updaterRunning', private.team_updater_running(team.id),
           'planCode', st.plan_code
         )
    into banner_json
  from public.teams as team
  cross join lateral private.space_tariff_state(team.id, now()) as st
  where team.owner_id = actor and team.status = 'active'
    and st.state in ('expiring', 'grace')
  order by st.ends_on, team.created_at
  limit 1;

  -- A grant or extension the admin chose to announce, once, for a week.
  select jsonb_build_object(
           'teamId', tariff.team_id,
           'kind', case when event.kind = 'extended' then 'renewed' else 'granted' end,
           'endsOn', event.after ->> 'endsOn',
           'eventId', event.id
         )
    into toast_json
  from public.space_tariff_events as event
  join public.space_tariffs as tariff on tariff.id = event.tariff_id
  where tariff.owner_id = actor
    and tariff.revoked_at is null
    and event.kind in ('granted', 'extended')
    and event.created_at > now() - interval '7 days'
    and event.toast_acked_at is null
    and event.undone_at is null
    and coalesce((event.after ->> 'notify')::boolean, false)
    and (tariff.team_id is null
         or (select st.state from private.space_tariff_state(tariff.team_id, now()) as st)
            not in ('legacy', 'internal'))
  order by event.created_at desc
  limit 1;

  select jsonb_build_object('planInterest', entry.plan_interest, 'channel', entry.channel,
                            'lastContactAt', entry.last_contact_at)
    into request_json
  from public.team_workspace_waitlist as entry where entry.user_id = actor;

  mode := case
    when any_allowed or can_create then 'workspace'
    when any_blocked then 'blocked'
    else 'showcase'
  end;

  return jsonb_build_object(
    'mode', mode,
    'canCreate', can_create,
    'pendingTariff', pending_json,
    'teams', teams_json,
    'invitations', invitations_json,
    'banner', banner_json,
    'toast', toast_json,
    'showcase', jsonb_build_object(
      'plans', coalesce((
        select jsonb_agg(private.tariff_plan_json(plan) order by plan.sort_order, plan.code)
        from public.tariff_plans as plan where plan.active and plan.showcase
      ), '[]'::jsonb),
      'contact', private.tariff_contact_json(),
      'email', actor_email,
      'request', request_json
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_extend_space_tariff(p_id uuid, p_months integer, p_notify boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  row_state text;
  base_day date;
  was_allowed boolean;
  event_id uuid;
begin
  if p_months is null or p_months not between 1 and 36 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select state.state into row_state from private.space_tariff_row_state(previous, now()) as state;
  if previous.revoked_at is not null then
    -- Bringing a revoked tariff back must not create a second live one.
    if exists (
      select 1 from public.space_tariffs as other
      where other.id <> previous.id and other.revoked_at is null
        and ((previous.team_id is not null and other.team_id = previous.team_id)
             or (previous.team_id is null and other.team_id is null
                 and lower(other.owner_email::text) = lower(previous.owner_email::text)))
    ) then
      raise exception 'TARIFF_BOUND' using errcode = 'P0001';
    end if;
  end if;
  base_day := case
    when previous.revoked_at is not null or row_state in ('blocked', 'pending_expired')
         or (row_state = 'legacy' and previous.ends_on + 3 < private.kyiv_today())
      then private.kyiv_today()
    else previous.ends_on
  end;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set ends_on = (base_day + make_interval(months => p_months))::date,
         revoked_at = null,
         updated_at = clock_timestamp()
   where tariff.id = p_id
  returning * into updated;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor, 'extended', private.space_tariff_snapshot(previous),
          private.space_tariff_snapshot(updated) || jsonb_build_object('notify', coalesce(p_notify, false)))
  returning id into event_id;

  if coalesce(p_notify, false) then
    perform private.queue_space_tariff_letter(p_id, 'renewed');
  end if;
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id) || jsonb_build_object('eventId', event_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_space_owner_nudge(p_team uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  owner uuid;
  st record;
  today date := private.kyiv_today();
  inserted uuid;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  select team.owner_id into owner
  from public.teams as team
  join public.team_members as member
    on member.team_id = team.id and member.user_id = actor and member.status = 'active'
  where team.id = p_team and team.status = 'active';
  if owner is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if owner = actor or private.team_workspace_allowed(p_team) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into st from private.space_tariff_state(p_team, now());
  if st.tariff_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.space_tariff_notices (tariff_id, kind, period_end, requested_by)
  values (st.tariff_id, 'member_nudge', today, actor)
  on conflict (tariff_id, kind, period_end) do nothing
  returning id into inserted;

  return jsonb_build_object(
    'sent', inserted is not null,
    'nextAllowedAt', to_jsonb(private.kyiv_day_end(today))
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.space_tariff_reference_lost()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if old.owner_id is not null and new.owner_id is null and new.revoked_at is null then
    new.revoked_at := now();
    new.updated_at := clock_timestamp();
    insert into public.space_tariff_events (tariff_id, team_id, kind, before, after)
    values (new.id, new.team_id, 'owner_deleted',
            jsonb_build_object('revokedAt', null), jsonb_build_object('revokedAt', new.revoked_at));
  end if;
  if old.team_id is not null and new.team_id is null and new.revoked_at is null
     and exists (
       select 1 from public.space_tariffs as other
       where other.id <> new.id and other.team_id is null and other.revoked_at is null
         and lower(other.owner_email::text) = lower(new.owner_email::text)
     ) then
    new.revoked_at := clock_timestamp();
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_end_space_tariff(p_id uuid, p_now boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  was_allowed boolean;
  waiting boolean;
begin
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous.revoked_at is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  waiting := previous.team_id is null;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  if coalesce(p_now, false) or waiting then
    -- Transaction time, which the gate compares against: the space closes within this call.
    update public.space_tariffs as tariff
       set revoked_at = now(), updated_at = clock_timestamp()
     where tariff.id = p_id
    returning * into updated;
  else
    update public.space_tariffs as tariff
       set ends_on = least(tariff.ends_on, private.kyiv_today()), updated_at = clock_timestamp()
     where tariff.id = p_id
    returning * into updated;
  end if;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor,
          case when coalesce(p_now, false) or waiting then 'ended_now' else 'ended_today' end,
          private.space_tariff_snapshot(previous), private.space_tariff_snapshot(updated));
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id);
end;
$function$;

select cron.unschedule(job.jobid) from cron.job as job where job.jobname='wishly-tariff-notices-queue';
select cron.schedule('wishly-tariff-notices-queue','7 * * * *',$cron$select private.queue_tariff_notices(now())$cron$);
CREATE OR REPLACE FUNCTION public.service_claim_tariff_notices(p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.tariff_settings_json()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'telegram', settings.admin_telegram,
    'email', settings.admin_email,
    'legacyRuleEnabled', coalesce(settings.legacy_rule_enabled, true),
    'legacySpacesRemaining', (select count(*)::integer from private.legacy_only_spaces())
  )
  from (select 1) as anchor
  left join public.tariff_settings as settings on settings.id;
$function$;

alter table public.space_tariffs alter column starts_at set default now();
drop function private.tariff_now();
commit;
