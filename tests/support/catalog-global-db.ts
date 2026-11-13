import { createTeamTestDb, createUser, type TeamTestDb } from './team-db.js';
import { globalFixtureId } from '../fixtures/catalog-global.js';
export const GLOBAL_OWNER = globalFixtureId(60001),
  GLOBAL_OTHER = globalFixtureId(60002),
  GLOBAL_IMAGE = globalFixtureId(60003);
export async function globalTestDb() {
  const db = await createTeamTestDb();
  await createUser(db, { id: GLOBAL_OWNER, email: 'owner@global.example.test' });
  await createUser(db, { id: GLOBAL_OTHER, email: 'other@global.example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [GLOBAL_OWNER]);
  const [team] = await db.asUser<{ id: string }>(
    GLOBAL_OWNER,
    "select id from public.create_team('Global fixtures')"
  );
  await db.root('insert into private.catalog_global_operators(actor_id) values($1)', [
    GLOBAL_OWNER
  ]);
  await db.root(
    "update private.catalog_global_policy set environment='beta',media_origin='https://media.example.test',routing_revision='fixture-v1',serving_revision='fixture-v1',serving_verified_at=clock_timestamp() where singleton"
  );
  await db.root(
    `insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,state,content_proof_revision,content_verified_at,content_expires_at)
  values($1::uuid,'beta','g1/'||$1::text,repeat('a',64),'image/jpeg',1000,500,500,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}','ready','fixture-v1',clock_timestamp(),clock_timestamp()+interval '24 hours')`,
    [GLOBAL_IMAGE]
  );
  await db.root(
    `insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
 select $1::uuid,g,'https://media.example.test/g/fixture-'||g||'.jpg',1,'ready','fixture-v1',clock_timestamp() from generate_series(1,3) g`,
    [GLOBAL_IMAGE]
  );
  return { db, team: team!.id };
}
export async function globalControl(
  db: TeamTestDb,
  action: string,
  payload: Record<string, unknown>,
  actor = GLOBAL_OWNER
) {
  const [row] = await db.root<{ value: Record<string, unknown> }>(
    'select public.service_catalog_global_control($1,$2,$3) value',
    [actor, action, JSON.stringify(payload)]
  );
  return row!.value;
}
export async function globalCutover(
  db: TeamTestDb,
  action: string,
  payload: Record<string, unknown> = {},
  actor = GLOBAL_OWNER
) {
  const [row] = await db.root<{ value: Record<string, unknown> }>(
    'select public.service_catalog_global_cutover($1,$2,$3) value',
    [actor, action, JSON.stringify(payload)]
  );
  return row!.value;
}
export async function activateGlobalFixture(db: TeamTestDb) {
  const prepared = await globalCutover(db, 'prepare');
  await db.root(
    "insert into private.catalog_global_acceptance(manifest_digest,environment,routing_revision,source_sha,evidence_digest,evidence,expires_at) values($1,'beta','fixture-v1',repeat('a',40),repeat('b',64),'{}',clock_timestamp()+interval '120 seconds') on conflict(manifest_digest) do nothing",
    [prepared.manifestDigest]
  );
  return globalCutover(db, 'activate', {
    manifestDigest: prepared.manifestDigest,
    confirmation: `activate:beta:fixture-v1:${prepared.manifestDigest}`,
    sourceSha: 'a'.repeat(40),
    acceptance: {
      current: 'verified',
      rollback: 'verified',
      provider: 'verified',
      diagnostics: 'verified',
      performance: 'verified'
    }
  });
}
