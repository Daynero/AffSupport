import { afterAll, beforeAll, expect, it } from 'vitest';
import { GLOBAL_OWNER, globalTestDb } from './support/catalog-global-db.js';
import { globalFixtureId } from './fixtures/catalog-global.js';
import type { TeamTestDb } from './support/team-db.js';

/**
 * next QA 2026-11-17: an updater round in a pilot space wrote its sheet, then completion
 * and reconciliation refused every shared pool row through the R2-only row validator,
 * so the catalog stayed «Результат невідомий» for good (20261217110000).
 */
let db: TeamTestDb, team: string;
beforeAll(async () => {
  ({ db, team } = await globalTestDb());
  await db.root('insert into private.catalog_global_pilot_teams(team_id) values($1)', [team]);
}, 60_000);
afterAll(async () => {
  await db?.close();
});

const validate = (images: unknown) =>
  db.root('select public.service_catalog_image_validate_rows_v2($1,$2)', [
    team,
    JSON.stringify(images)
  ]);

it('accepts the pool rows a pilot round issued, through the validator completion uses', async () => {
  const [row] = await db.root<{ images: Array<Record<string, unknown>> }>(
    `select public.service_catalog_global_allocate($1,$2,$3,$4,2,private.catalog_global_epoch($2))->'images' images`,
    [GLOBAL_OWNER, team, globalFixtureId(67001), globalFixtureId(67002)]
  );
  const images = row!.images;
  expect(images.length).toBeGreaterThan(0);
  expect(images.every(image => image.kind === 'global')).toBe(true);
  await expect(validate(images)).resolves.toBeDefined();
  // A pool row the pool never issued is still refused, by the pool's own check.
  await expect(validate([{ ...images[0], assignmentId: globalFixtureId(67999) }])).rejects.toThrow(
    'GLOBAL_IMAGE_READINESS_UNKNOWN'
  );
});

it('keeps the R2 check for a space’s own rows, alone or beside pool rows', async () => {
  const own = {
    kind: 'r2',
    publicationId: globalFixtureId(67101),
    poolEntryId: globalFixtureId(67102),
    publicUrl: 'https://media.example.test/own.jpg',
    classification: { mode: 'unclassified' },
    revision: 1
  };
  await expect(validate([own])).rejects.toThrow('IMAGE_PUBLICATION_REVOKED');
  await expect(validate([{ kind: 'r2' }])).rejects.toThrow('INVALID_RESPONSE');
  await expect(validate([])).resolves.toBeDefined();
});

it('reconciles through the image-use functions that confirm a pool recipe', async () => {
  const [row] = await db.root<{ d: string }>(
    "select pg_get_functiondef('private.publication_legacy_resolve_catalog_reconciliation(uuid,uuid,text,text)'::regprocedure) d"
  );
  expect(row!.d).toContain('service_catalog_image_validate_uses_v3(');
  expect(row!.d).toContain('service_catalog_image_finalize_uses_v3(');
  expect(row!.d).not.toMatch(/service_catalog_image_(?:validate|finalize)_uses_v2\(/u);
});
