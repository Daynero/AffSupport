-- Production 2026-11-26: public.search_materials hit the statement timeout 19 times in an hour
-- (08:16-09:10 UTC), every one of them in the two largest spaces.
--
-- 20261206149200 hides «Soty cache»/«.soty» folders with everything below them. It walks down
-- from those folders by parent_folder_id, deliberately through rows of ANY lifecycle (a trashed
-- or missing folder in the middle must not let the files below it back into the results). Every
-- index that leads to a folder's children is partial on lifecycle = 'active', so none of them
-- could answer that step. With a literal space id the planner hashed the whole space once per
-- level (150 ms for 12 000 rows). Called from PL/pgSQL on a pooled connection the statement runs
-- on its generic plan, which looked the children up once per ROW already found, each time by
-- intersecting two bitmaps over the whole space: 527 cache rows x 12 000 rows, 8 seconds and more.
--
-- This index answers "the rows under this folder, whatever their lifecycle" as one probe.
-- Results do not change: the function is untouched.
--
-- On production the table holds under 30 000 rows, so building it takes well under a second;
-- an operator who wants no write pause at all creates it CONCURRENTLY under this name first,
-- and this migration then finds it in place.
create index if not exists team_materials_children_idx
 on public.team_materials (team_id, connection_id, parent_folder_id);
