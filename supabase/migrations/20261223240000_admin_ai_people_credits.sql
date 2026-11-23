-- 064: credits are managed where people are managed — next to each space's tariff. The Tariffs
-- tab reads the balance of the owners it lists in one call: today's grant and what is left of it,
-- bonus credits held, and the total that can be spent now.
create function public.admin_ai_people_credits(p_emails text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_ai_admin();
  if p_emails is null or cardinality(p_emails) > 500 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'email', u.email,
      'grant', (s ->> 'grant')::integer,
      'daily', (s ->> 'daily')::integer,
      'bonus', (s ->> 'bonus')::integer,
      'available', (s ->> 'available')::integer,
      'personalGrant', g.daily_grant
    ) order by u.email)
    from auth.users u
    cross join lateral private.ai_credits_snapshot(u.id) s
    left join private.ai_credit_grants g on g.user_id = u.id
    where lower(u.email) = any (select lower(e) from unnest(p_emails) e)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_ai_people_credits(text[]) from public, anon;
grant execute on function public.admin_ai_people_credits(text[]) to authenticated;
