-- 062: analytics of Launches with several creatives and image creatives.
--
-- The server allowlist drops an event whose property key it does not know, so
-- the new properties are added here, named like the existing launch keys
-- (snake_case): creative_kind, creative_count, product_count, variation_count,
-- custom_distribution, creative_ordinal, failed_ordinal. Counts and ordinals
-- are bounded numbers; the kind is an enum; the distribution flag is a
-- boolean. The new launch_code values are accepted too. No names, ids or URLs.
-- The body is patched from the live definition, so changes made by other
-- migrations to the same guard survive.
begin;

create function private.patch_function_062(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function; end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_062_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062(regprocedure, text, text) from public, anon, authenticated, service_role;

-- Keys.
select private.patch_function_062('public.analytics_properties_are_safe_v2(jsonb)'::regprocedure,
  $find$'prepare_ms','skeleton_ms','layout_shift_milli','long_frame_count'
      ])$find$,
  $repl$'prepare_ms','skeleton_ms','layout_shift_milli','long_frame_count',
        'creative_kind','creative_count','product_count','variation_count','custom_distribution','creative_ordinal','failed_ordinal'
      ])$repl$);

-- Bounded numbers.
select private.patch_function_062('public.analytics_properties_are_safe_v2(jsonb)'::regprocedure,
  $find$        ('long_frame_count', 0, 1000)
      ) as bound(key, low, high)$find$,
  $repl$        ('long_frame_count', 0, 1000),
        ('creative_count', 1, 400),
        ('product_count', 1, 400),
        ('variation_count', 0, 400),
        ('creative_ordinal', 0, 399),
        ('failed_ordinal', 0, 399)
      ) as bound(key, low, high)$repl$);

-- The kind, the flag and the new refusal codes.
select private.patch_function_062('public.analytics_properties_are_safe_v2(jsonb)'::regprocedure,
  $find$    and case when payload ? 'launch_code' then payload ->> 'launch_code' in ('GLOBAL_IMAGE_POOL_UNAVAILABLE',$find$,
  $repl$    and case when payload ? 'creative_kind' then payload ->> 'creative_kind' in ('video','image') else true end
    and case when payload ? 'custom_distribution' then jsonb_typeof(payload -> 'custom_distribution') = 'boolean' else true end
    and case when payload ? 'launch_code' then payload ->> 'launch_code' in ('CREATIVES_MIXED','CREATIVES_LIMIT','CREATIVE_DUPLICATE','DISTRIBUTION_INVALID','VARIATIONS_RANGE','CREATIVE_IMAGE_FORMAT','CREATIVE_IMAGE_TOO_LARGE','PUBLIC_READ_UNVERIFIED','MULTI_CREATIVE_UNSUPPORTED','GLOBAL_IMAGE_POOL_UNAVAILABLE',$repl$);

drop function private.patch_function_062(regprocedure, text, text);

commit;
