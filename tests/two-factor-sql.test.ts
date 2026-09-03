import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 016: the 2FA notebook's storage, against a real Postgres with every
 * migration applied.
 *
 * The point of these cases is not that a person can store a seed — it is that
 * nobody else can reach it, and that a seed never exists anywhere but the vault.
 * A 2FA seed is standing account access; a hole here is not a bug report, it is
 * somebody else's advertising account.
 *
 * What PGlite cannot answer lives in `supabase/tests/database/two-factor.test.sql`:
 * the harness runs every statement on a superuser connection with a JWT claim
 * set, so grants and RLS are not *enforced* here. This suite therefore asserts
 * their presence from the catalog and leaves enforcement to pgTAP.
 */

const OWNER = '30000000-0000-4000-8000-000000000001';
const STRANGER = '30000000-0000-4000-8000-000000000002';

const SEED = 'JBSWY3DPEHPK3PXP';
const OTHER_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

interface EntryRow {
  id: string;
  name: string;
  secret: string;
  // PGlite hands back Date objects for timestamptz, so these are compared with
  // toEqual rather than toBe — two equal instants are not the same instance.
  created_at: Date;
  updated_at: Date;
}

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@example.test', displayName: 'Owner' });
  await createUser(harness, {
    id: STRANGER,
    email: 'stranger@example.test',
    displayName: 'Stranger'
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function addEntry(userId: string, name: string, secret = SEED): Promise<EntryRow> {
  const rows = await harness.asUser<EntryRow>(
    userId,
    'select * from public.create_two_factor_entry($1, $2)',
    [name, secret]
  );
  return rows[0]!;
}

async function listEntries(userId: string): Promise<EntryRow[]> {
  return harness.asUser<EntryRow>(userId, 'select * from public.list_two_factor_entries()');
}

async function vaultCount(): Promise<number> {
  const rows = await harness.root<{ total: string }>(
    'select count(*)::text as total from vault.secrets'
  );
  return Number(rows[0]!.total);
}

async function clearNotebooks(): Promise<void> {
  await harness.root('delete from private.two_factor_entries');
  await harness.root("delete from vault.secrets where name like 'soty-2fa-%'");
}

describe('storing and reading back', () => {
  afterAll(clearNotebooks);

  it('returns the seed exactly as it went in', async () => {
    const created = await addEntry(OWNER, 'Facebook — main BM');
    expect(created.name).toBe('Facebook — main BM');
    expect(created.secret).toBe(SEED);

    const listed = await listEntries(OWNER);
    expect(listed.map(entry => entry.secret)).toContain(SEED);
  });

  it('keeps the seed out of the table entirely', async () => {
    const rows = await harness.root<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'private' and table_name = 'two_factor_entries'`
    );
    const columns = rows.map(row => row.column_name);
    expect(columns).toContain('vault_secret_id');
    // Not "no column named secret" — no column holding one. The row points at
    // the vault and knows nothing else.
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'owner', 'name', 'vault_secret_id', 'created_at', 'updated_at'])
    );
    expect(columns).toHaveLength(6);
  });

  it('lists newest first', async () => {
    await clearNotebooks();
    const first = await addEntry(OWNER, 'First');
    const second = await addEntry(OWNER, 'Second');
    const listed = await listEntries(OWNER);
    expect(listed.map(entry => entry.id)).toEqual([second.id, first.id]);
  });

  it('allows two entries to carry the same name', async () => {
    await clearNotebooks();
    await addEntry(OWNER, 'Google');
    await expect(addEntry(OWNER, 'Google', OTHER_SEED)).resolves.toMatchObject({ name: 'Google' });
    expect(await listEntries(OWNER)).toHaveLength(2);
  });
});

describe('the notebook is one person’s', () => {
  afterAll(clearNotebooks);

  it('shows a stranger nothing', async () => {
    await clearNotebooks();
    await addEntry(OWNER, 'Owner’s account');
    expect(await listEntries(STRANGER)).toEqual([]);
  });

  it('refuses a stranger’s edit and delete with the same code as a missing row', async () => {
    await clearNotebooks();
    const entry = await addEntry(OWNER, 'Owner’s account');
    const absent = '30000000-0000-4000-8000-0000000000ff';

    // Identical codes on purpose: a distinguishable "forbidden" would turn these
    // functions into a way to ask whether an id exists.
    await expect(
      harness.asUser(STRANGER, 'select * from public.update_two_factor_entry($1, $2, $3)', [
        entry.id,
        'Taken over',
        null
      ])
    ).rejects.toThrow(/ENTRY_NOT_FOUND/u);
    await expect(
      harness.asUser(STRANGER, 'select * from public.update_two_factor_entry($1, $2, $3)', [
        absent,
        'Taken over',
        null
      ])
    ).rejects.toThrow(/ENTRY_NOT_FOUND/u);
    await expect(
      harness.asUser(STRANGER, 'select public.delete_two_factor_entry($1)', [entry.id])
    ).rejects.toThrow(/ENTRY_NOT_FOUND/u);

    // And the entry is still there, untouched.
    const listed = await listEntries(OWNER);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('Owner’s account');
  });

  it('refuses a caller with no session', async () => {
    await expect(
      harness.asUser(null, 'select * from public.list_two_factor_entries()')
    ).rejects.toThrow(/NOT_AUTHENTICATED/u);
    await expect(
      harness.asUser(null, 'select * from public.create_two_factor_entry($1, $2)', ['X', SEED])
    ).rejects.toThrow(/NOT_AUTHENTICATED/u);
  });
});

describe('editing', () => {
  afterAll(clearNotebooks);

  it('renames without touching the seed or the row’s identity', async () => {
    await clearNotebooks();
    const entry = await addEntry(OWNER, 'Old name');
    const rows = await harness.asUser<EntryRow>(
      OWNER,
      'select * from public.update_two_factor_entry($1, $2, $3)',
      [entry.id, 'New name', null]
    );
    expect(rows[0]!.id).toBe(entry.id);
    expect(rows[0]!.name).toBe('New name');
    expect(rows[0]!.secret).toBe(SEED);
    expect(rows[0]!.created_at).toEqual(entry.created_at);
  });

  it('replaces the seed in place, keeping one vault secret', async () => {
    await clearNotebooks();
    const entry = await addEntry(OWNER, 'Rotating');
    const before = await vaultCount();
    const rows = await harness.asUser<EntryRow>(
      OWNER,
      'select * from public.update_two_factor_entry($1, $2, $3)',
      [entry.id, 'Rotating', OTHER_SEED]
    );
    expect(rows[0]!.secret).toBe(OTHER_SEED);
    expect(await vaultCount()).toBe(before);
  });
});

describe('deleting', () => {
  afterAll(clearNotebooks);

  it('takes the vault secret with the row', async () => {
    await clearNotebooks();
    const before = await vaultCount();
    const entry = await addEntry(OWNER, 'Temporary');
    expect(await vaultCount()).toBe(before + 1);

    await harness.asUser(OWNER, 'select public.delete_two_factor_entry($1)', [entry.id]);
    expect(await listEntries(OWNER)).toEqual([]);
    expect(await vaultCount()).toBe(before);
  });
});

describe('what a rejected entry leaves behind', () => {
  afterAll(clearNotebooks);

  it('leaves no orphaned secret when the seed is refused', async () => {
    await clearNotebooks();
    const before = await vaultCount();
    for (const bad of ['short', 'has spaces in it', 'JBSWY3DPEHPK3PX0']) {
      await expect(addEntry(OWNER, 'Rejected', bad)).rejects.toThrow(/INVALID_SECRET/u);
    }
    expect(await vaultCount()).toBe(before);
  });

  it('leaves no orphaned secret when the name is refused', async () => {
    await clearNotebooks();
    const before = await vaultCount();
    await expect(addEntry(OWNER, '   ')).rejects.toThrow(/INVALID_NAME/u);
    await expect(addEntry(OWNER, 'x'.repeat(121))).rejects.toThrow(/INVALID_NAME/u);
    expect(await vaultCount()).toBe(before);
  });
});

describe('the shape of the protection', () => {
  it('enables row-level security and grants nothing to the client role', async () => {
    const [table] = await harness.root<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class
       where oid = 'private.two_factor_entries'::regclass`
    );
    expect(table!.relrowsecurity).toBe(true);

    // No policy at all, deliberately: the definer functions are the only door,
    // so there is nothing for a policy to let through.
    const policies = await harness.root(
      `select policyname from pg_policies
       where schemaname = 'private' and tablename = 'two_factor_entries'`
    );
    expect(policies).toEqual([]);

    const grants = await harness.root(
      `select privilege_type from information_schema.role_table_grants
       where table_schema = 'private' and table_name = 'two_factor_entries'
         and grantee in ('authenticated', 'anon')`
    );
    expect(grants).toEqual([]);
  });

  it('runs every function as a definer with a pinned search path', async () => {
    const rows = await harness.root<{ proname: string; prosecdef: boolean; config: string | null }>(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like '%two_factor%'
       order by p.proname`
    );
    expect(rows.map(row => row.proname)).toEqual([
      'create_two_factor_entry',
      'delete_two_factor_entry',
      'list_two_factor_entries',
      'update_two_factor_entry'
    ]);
    for (const row of rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.config).toContain('search_path=');
    }
  });
});
