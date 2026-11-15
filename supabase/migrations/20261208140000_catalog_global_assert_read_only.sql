-- Production 2026-11-15: «Створити» stayed disabled for every 1.4.4 browser.
--
-- 20261208100100_catalog_global_cutover.sql put a guard at the top of eight catalog
-- entry points. The guard reads the global policy row `for key share`. Three of those
-- entry points are STABLE (get_team_product_catalog_settings,
-- list_team_product_catalog_image_sources, get_team_catalog_updater_refresh_images), and
-- PostgREST runs a STABLE function in a read-only transaction, where a row lock raises
-- 25006 «cannot execute SELECT FOR KEY SHARE in a read-only transaction». PostgREST
-- answers that with 405. The create dialog in 1.4.4 reads the settings before it enables
-- «Створити», took the failure as "unknown" and kept the button disabled without a word.
--
-- The lock exists so a write cannot interleave with the cutover. A read has nothing to
-- protect: in a read-only transaction the guard reads the state without the lock. A write
-- keeps the lock exactly as before. The meaning of the check (`<>` against 'prepared') does
-- not change.
create or replace function private.catalog_global_assert_legacy_settings() returns void
language plpgsql security definer set search_path='' as $$
declare policy_state text;
begin
 if current_setting('transaction_read_only') = 'on' then
  select state into policy_state from private.catalog_global_policy where singleton;
 else
  select state into policy_state from private.catalog_global_policy where singleton for key share;
 end if;
 if policy_state<>'prepared' then raise exception 'GLOBAL_IMAGE_SETTINGS_RETIRED';end if;
end $$;
revoke all on function private.catalog_global_assert_legacy_settings() from public,anon,authenticated,service_role;
