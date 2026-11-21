-- 064: what the read-only analytics CLI may see of credits and the launch assistant. Codes,
-- states, counts and amounts only: no message text, no plan, no card payload, no link.

create view public.analytics_assistant_commands with (security_invoker = false) as
select c.id, c.team_id, c.user_id, c.kind, c.status, c.reason_code, c.model, c.price,
  c.created_at, c.updated_at,
  (select count(*) from private.assistant_command_effects e where e.command_id = c.id)::integer as effects,
  (select count(*) from private.assistant_command_effects e where e.command_id = c.id and e.undone_at is not null)::integer as undone_effects,
  (select array_agg(k.kind order by k.created_at) from private.assistant_cards k where k.command_id = c.id) as card_kinds,
  (select count(*) from private.assistant_cards k where k.command_id = c.id and k.kind = 'review' and k.state = 'launched')::integer as launched_reviews
from private.assistant_commands c;

create view public.analytics_ai_credit_ledger with (security_invoker = false) as
select l.id, l.user_id, l.op_key, l.kind, l.kyiv_day, l.feature, l.amount, l.price_version, l.created_at
from private.ai_credit_ledger l;

create view public.analytics_ai_month_holds with (security_invoker = false) as
select h.op_key, h.month, h.subject_id, h.usd_upper, h.usd_actual, h.state, h.created_at, h.settled_at
from private.ai_month_holds h;

revoke all on public.analytics_assistant_commands, public.analytics_ai_credit_ledger,
  public.analytics_ai_month_holds from public, anon, authenticated, service_role;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_assistant_commands, public.analytics_ai_credit_ledger,
      public.analytics_ai_month_holds to wishly_analytics_ro;
  end if;
end $$;
