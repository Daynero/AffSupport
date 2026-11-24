-- Production 2026-11-24, release 1.6.3: the one-time heal of 20261224130000 hit the statement
-- timeout three times. For each of ~7600 removed materials it read the catalog intents of the
-- team and unpacked their checkpoint (about 100 KB each) to compare its materialId. These two
-- expression indexes answer that comparison without reading the checkpoint; they were created
-- concurrently on production before the release resumed, so here they only exist if missing.
create index if not exists catalog_generation_intents_checkpoint_material_idx
 on private.catalog_generation_intents ((checkpoint->>'materialId'));
create index if not exists catalog_generation_intents_result_material_idx
 on private.catalog_generation_intents ((result#>>'{catalog,materialId}'));
