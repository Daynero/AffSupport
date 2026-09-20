-- Feature 024 US27 — a picture says what it shows, and the row says the same thing.
--
-- The space's pictures are named the way the owner names them: `hoodie_black_01.jpg`,
-- `tank-top_sage_01.jpg` — the garment, the colour, the shot. A catalog drew a picture and a name
-- from two pools that knew nothing of each other, so a photo of a black hoodie could be sold as a
-- navy wide-leg jeans. The draw now hands back the file's name, which is all the planner needs to
-- pair a row's words with its picture; and the space can read what its pool actually holds, so the
-- generator writes names for the clothes there are pictures of.
-- Forward-only; ROLLBACK.md re-applies the draw from 20260917170000 and drops the listing.

drop function if exists public.service_draw_product_catalog_images(uuid, integer);
create function public.service_draw_product_catalog_images(p_team uuid, p_count integer)
returns table (material_id uuid, drive_file_id text, resource_key text, name text)
language sql
security definer
set search_path = ''
as $$
  select material.id, material.drive_file_id, material.resource_key, material.name
  from private.draw_product_catalog_items(p_team, 'image', p_count) with ordinality as drawn(id, n)
  join public.team_materials as material on material.id = drawn.id
  order by drawn.n;
$$;

/** The names of the pictures a space would draw from, for the generator to write around. */
create or replace function public.list_team_product_catalog_pool_names(
  p_team uuid, p_limit integer default 500
)
returns table (name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select image.name
  from private.product_catalog_pool_images(p_team) as image
  order by image.name
  limit least(greatest(coalesce(p_limit, 500), 1), 2000);
end;
$$;

revoke all on function public.service_draw_product_catalog_images(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.list_team_product_catalog_pool_names(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.service_draw_product_catalog_images(uuid, integer) to service_role;
grant execute on function public.list_team_product_catalog_pool_names(uuid, integer) to authenticated;
