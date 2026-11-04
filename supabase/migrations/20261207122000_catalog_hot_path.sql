-- Per-row image evidence is projected through a privacy-safe view whose key is text.
-- Without the matching index, every reserved/committed row scans the entire journal.
-- Preserve the diagnostic producer and its closed vocabularies; bound the lookup instead.
begin;
create index catalog_image_journal_evidence_id on private.catalog_image_journal ((seq::text));

create or replace function public.service_catalog_image_finalize_uses_v2(p_team uuid,p_attempt uuid,p_delivered boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 -- A publication may be referenced by every product row. Lock each publication once,
 -- with the same ordering and team advisory fence as revocation and draw.
 perform 1 from private.catalog_image_publications p
 where exists(select 1 from private.catalog_image_uses u where u.publication_id=p.id and u.team_id=p_team and u.catalog_attempt_id=p_attempt)
 order by p.id for update of p;
 if p_delivered and exists(select 1 from private.catalog_image_uses u join private.catalog_image_publications p on p.id=u.publication_id where u.team_id=p_team and u.catalog_attempt_id=p_attempt and p.state<>'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
 update private.catalog_image_uses set state=case when p_delivered then 'committed' else 'unknown' end where team_id=p_team and catalog_attempt_id=p_attempt and state<>'committed';
end $$;

create or replace function public.service_catalog_image_validate_uses_v2(p_team uuid,p_attempt uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 -- A publication may be referenced by every product row. Lock each publication once,
 -- with the same ordering and team advisory fence as revocation and draw.
 perform 1 from private.catalog_image_publications p
 where exists(select 1 from private.catalog_image_uses u where u.publication_id=p.id and u.team_id=p_team and u.catalog_attempt_id=p_attempt)
 order by p.id for update of p;
 if exists(select 1 from private.catalog_image_uses u join private.catalog_image_publications p on p.id=u.publication_id where u.team_id=p_team and u.catalog_attempt_id=p_attempt and p.state<>'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
end $$;
commit;
