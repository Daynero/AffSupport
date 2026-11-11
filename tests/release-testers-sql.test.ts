import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 051: who may use the release candidate on `next`, against a real
 * Postgres with every migration applied. Grants are asserted from the catalog;
 * PGlite runs as a superuser, so it cannot enforce them.
 */

const ADMIN = '51000000-0000-4000-8000-000000000001';
const TESTER = '51000000-0000-4000-8000-000000000002';
const STRANGER = '51000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: ADMIN, email: 'admin@example.test', displayName: 'Admin' });
  await createUser(harness, { id: TESTER, email: 'Tester@Example.test', displayName: 'Tester' });
  await createUser(harness, { id: STRANGER, email: 'stranger@example.test', displayName: 'S' });
  await harness.root('insert into public.admin_users (user_id) values ($1)', [ADMIN]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const isTester = async (user: string) =>
  (await harness.asUser<{ ok: boolean }>(user, 'select public.is_release_tester() as ok'))[0]!.ok;

describe('release testers', () => {
  it('lets administrators in without a list entry', async () => {
    expect(await isTester(ADMIN)).toBe(true);
    expect(await isTester(TESTER)).toBe(false);
  });

  it('adds a tester by email, case-insensitively, and only for an administrator', async () => {
    await expect(
      harness.asUser(STRANGER, 'select public.admin_add_release_tester($1)', [
        'tester@example.test'
      ])
    ).rejects.toThrow('Administrator access required');
    await harness.asUser(ADMIN, 'select public.admin_add_release_tester($1)', [
      ' tester@example.TEST '
    ]);
    expect(await isTester(TESTER)).toBe(true);
    expect(await isTester(STRANGER)).toBe(false);
    const list = await harness.asUser<{ email: string }>(
      ADMIN,
      'select * from public.admin_list_release_testers()'
    );
    expect(list.map(row => row.email)).toEqual(['Tester@Example.test']);
  });

  it('names an unknown email and removes a tester', async () => {
    await expect(
      harness.asUser(ADMIN, 'select public.admin_add_release_tester($1)', ['nobody@example.test'])
    ).rejects.toThrow('RELEASE_TESTER_UNKNOWN_EMAIL');
    await harness.asUser(ADMIN, 'select public.admin_remove_release_tester($1)', [TESTER]);
    expect(await isTester(TESTER)).toBe(false);
  });

  it('keeps the table itself closed to browsers', async () => {
    const grants = await harness.root<{ grantee: string }>(
      `select grantee from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'release_testers'
         and grantee in ('anon', 'authenticated')`
    );
    expect(grants).toEqual([]);
    const rls = await harness.root<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.release_testers'::regclass"
    );
    expect(rls[0]!.relrowsecurity).toBe(true);
  });
});
