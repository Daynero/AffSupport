-- 062: several creatives of a catalog Launch may carry one name the person typed («pak_1»).
--
-- `creativeLabel` lives in the Launch config next to `creatives`: SUB «Креатив», campaign names
-- and the result's title use it instead of the automatic «<first>+N» (shared launchCreativeLabel,
-- computed by drive-ops at generation, so the agent is not involved). This migration
--   * refuses a config whose `creativeLabel` is not 1..80 characters of [A-Za-z0-9_+-]
--     (the alphabet the web writes, the SUB patcher accepts and «+» goes out as %2B), at the draft
--     boundary and at admission alike — both read private.launch_creatives_error;
--   * lists the name on the Launch card (`creativeLabel`) and lets the list search find it.
-- Additive: a config without `creativeLabel` checks, lists and searches exactly as before.
begin;

do $label$
declare d text;
  anchor constant text := $find$  if jsonb_typeof(p_config) is distinct from 'object' then return 'INVALID_INPUT'; end if;
$find$;
begin
  select pg_get_functiondef('private.launch_creatives_error(jsonb,boolean)'::regprocedure) into d;
  if strpos(d, anchor) = 0 then raise exception 'LAUNCH_CREATIVE_LABEL_PATCH_MISSING'; end if;
  d := replace(d, anchor, anchor || $add$  if p_config ? 'creativeLabel' and (jsonb_typeof(p_config->'creativeLabel') is distinct from 'string'
     or char_length(p_config->>'creativeLabel') not between 1 and 80
     or p_config->>'creativeLabel' !~ '^[A-Za-z0-9_+-]+$') then
    return 'LAUNCH_SUB_INVALID';
  end if;
$add$);
  execute d;
end $label$;

do $list$
declare d text;
  card constant text := $find$        'creativeCount', greatest(1, case when r.id is not null then$find$;
  search constant text := $find$          coalesce(r.config->>'creativeAlias', l.draft_config->>'creativeAlias', '')
        )) > 0$find$;
begin
  select pg_get_functiondef('private.list_launches_pre_assignment(uuid,jsonb,integer)'::regprocedure) into d;
  if strpos(d, card) = 0 or strpos(d, search) = 0 then raise exception 'LAUNCH_LIST_CREATIVE_LABEL_PATCH_MISSING'; end if;
  d := replace(d, card, $add$        'creativeLabel', case when r.id is not null then r.config->>'creativeLabel' else l.draft_config->>'creativeLabel' end,
$add$ || card);
  d := replace(d, search, $add$          coalesce(r.config->>'creativeAlias', l.draft_config->>'creativeAlias', '') || ' ' ||
          coalesce(case when r.id is not null then r.config->>'creativeLabel' else l.draft_config->>'creativeLabel' end, '')
        )) > 0$add$);
  execute d;
end $list$;

commit;
