-- 1.4.3: every new space gets R2 catalog images from the start.
--
-- The per-space row in private.catalog_image_config is created lazily, the
-- first time the space opens its image settings (service_catalog_image_control_v2
-- inserts (team_id) on conflict do nothing). With import_enabled defaulting to
-- false, a new space met «Завантаження зображень ще не підключене» and only the
-- legacy Google Drive sources. The lazily created row now starts enabled; the
-- space still flips to mode='v2' on its first ready image, exactly as before.
--
-- Existing rows keep the value they have: a space that was turned off on
-- purpose stays off.
begin;
alter table private.catalog_image_config alter column import_enabled set default true;
commit;
