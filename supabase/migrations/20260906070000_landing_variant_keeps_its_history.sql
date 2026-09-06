-- Renaming the landing variant must not forget what was already done.
--
-- 20260906060000 stopped keying `landing_optimization` by the reader's
-- interface language and retired the language-keyed rows — but only the
-- `pending` and `failed` ones. A finished optimisation is `ready`, and those
-- kept `variant = 'uk'`, which does not collide with the new `'default'` on the
-- unique key (team, source, version, kind, variant). So the first scan after
-- that migration would have inserted a fresh pending job for every landing that
-- had already been optimised, in every space, and offered them all again.
--
-- The rename is done in place instead: for each source version the most
-- advanced landing row survives and becomes `'default'`, and the rest are
-- retired. A retired row keeps its place in the table — results point at it —
-- so it is first given a variant of its own, or it would still be sitting on
-- the `'default'` key the survivor needs.

create temporary table landing_rename on commit drop as
select requirement.id,
       row_number() over (
         partition by requirement.team_id, requirement.source_material_id, requirement.source_version
         order by case requirement.state
                    when 'ready' then 0
                    when 'running' then 1
                    when 'leased' then 2
                    when 'pending' then 3
                    when 'failed' then 4
                    when 'skipped' then 5
                    when 'canceled' then 6
                    else 7
                  end,
                  requirement.created_at desc,
                  requirement.id
       ) as rank
from public.team_library_requirements as requirement
where requirement.kind = 'landing_optimization';

update public.team_library_requirements as requirement
   set state = 'stale',
       -- Out of the way of the key the survivor is about to take, and still
       -- readable as what it was.
       variant = 'retired:' || left(requirement.id::text, 36)
 where requirement.id in (select id from landing_rename where rank > 1);

update public.team_library_requirements as requirement
   set variant = 'default'
 where requirement.id in (select id from landing_rename where rank = 1)
   and requirement.variant <> 'default';
