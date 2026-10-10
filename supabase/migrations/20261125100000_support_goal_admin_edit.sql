-- The admin edits the whole active donation goal — its title in both
-- languages, its target and the raised total — not only the raised amount.
--
-- `admin_update_support_goal_amount` stays as it was so a web build that
-- predates this migration keeps working; the new web calls this function.

create or replace function public.admin_update_support_goal(
  p_goal_id uuid,
  p_title_en text,
  p_title_uk text,
  p_target_cents bigint,
  p_raised_cents bigint
)
returns public.support_goals
language plpgsql
security definer
set search_path = ''
as $$
declare
  goal public.support_goals;
  v_title_en text := btrim(p_title_en);
  v_title_uk text := btrim(p_title_uk);
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if v_title_en is null
    or v_title_uk is null
    or char_length(v_title_en) not between 1 and 160
    or char_length(v_title_uk) not between 1 and 160 then
    raise exception 'Invalid goal title' using errcode = '22023';
  end if;
  if p_target_cents is null
    or p_target_cents < 1
    or p_target_cents > 1000000000000 then
    raise exception 'Invalid target amount' using errcode = '22023';
  end if;
  if p_raised_cents is null
    or p_raised_cents < 0
    or p_raised_cents > 1000000000000 then
    raise exception 'Invalid raised amount' using errcode = '22023';
  end if;

  update public.support_goals
  set
    title_en = v_title_en,
    title_uk = v_title_uk,
    target_cents = p_target_cents,
    raised_cents = p_raised_cents
  where id = p_goal_id
    and status = 'active'
  returning * into goal;

  if goal.id is null then
    raise exception 'Active support goal not found' using errcode = 'P0002';
  end if;

  return goal;
end;
$$;

revoke all on function public.admin_update_support_goal(uuid, text, text, bigint, bigint)
  from public, anon;
grant execute on function public.admin_update_support_goal(uuid, text, text, bigint, bigint)
  to authenticated;

comment on function public.admin_update_support_goal(uuid, text, text, bigint, bigint) is
  'Updates the title, target and aggregate raised amount of the active goal after an admin check.';
