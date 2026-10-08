import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { seedSyncScenario } from './fixtures/catalog-sync';
import { setQueryExecutor } from '../scripts/analytics/db';
import { getSyncJobs } from '../scripts/analytics/queries';
import { formatSyncJobs } from '../scripts/analytics/format';
import { buildCommandEnvelope, syncOutputIsPrivate } from '../scripts/analytics/types';
import { resolvePeriod } from '../scripts/analytics/periods';

/**
 * 028 — `npm run analytics -- sync <team | owner-email>` runs its exact SQL
 * against the diagnostics view on an in-process Postgres. The command must
 * show why a scan waits and must never show a cursor, a token or a name.
 */

const owner = '28100000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let connection: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'sync-owner@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [created] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Diag')"
  );
  team = created!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('diag', 'sync-owner@example.test', 'https://www.googleapis.com/auth/drive.file',
       gen_random_uuid(), $1) returning id`,
    [owner]
  );
  const [row] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, change_page_token)
     values ($1, $2, 'root-secret-id', 'Private Root Name', 'my_drive', 'connected', 'token-secret')
     returning id`,
    [team, credential!.id]
  );
  connection = row!.id;
  await seedSyncScenario(db, connection, 'waiter-canonical-failed', { folder: 'folder-secret-id' });
  await seedSyncScenario(db, connection, 'leased-expired', { folder: 'other-secret-id' });
  setQueryExecutor(async (sql, params) => db.root(sql, params));
}, 60_000);

afterAll(async () => {
  setQueryExecutor(null);
  await db?.close();
});

describe('analytics sync command', () => {
  it('lists the jobs of a team by id, grouped by connection with the canonical feed beside them', async () => {
    const data = await getSyncJobs(team);
    expect(data?.team_id).toBe(team);
    expect(data?.connections).toHaveLength(1);
    const [conn] = data!.connections;
    expect(conn!.connection_id).toBe(connection);
    expect(conn!.jobs.length).toBeGreaterThanOrEqual(3);
    const waiter = conn!.jobs.find(job => job.replay_after !== null);
    expect(waiter).toMatchObject({
      job_kind: 'user_subtree',
      state: 'pending',
      phase: 'change_replay'
    });
    expect(waiter!.scope_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(waiter!.canonical_state).toBeDefined();
  });

  it('resolves the owner email without returning it', async () => {
    const data = await getSyncJobs('sync-owner@example.test');
    expect(data?.team_id).toBe(team);
    expect(JSON.stringify(data)).not.toContain('sync-owner@example.test');
  });

  it('returns null for an unknown space and bounds the limit', async () => {
    expect(await getSyncJobs('nobody@example.test')).toBeNull();
    expect(await getSyncJobs(team, 0)).not.toBeNull();
    expect((await getSyncJobs(team, 1))?.connections[0]?.jobs).toHaveLength(1);
  });

  it('formats a human table and a stable JSON envelope', async () => {
    const period = resolvePeriod('7d', undefined);
    const data = (await getSyncJobs(team))!;
    const human = formatSyncJobs(data, period, Date.now());
    expect(human).toContain('Sync jobs');
    expect(human).toContain('Waits for');
    expect(human).toContain('seq 1');
    const envelope = buildCommandEnvelope('sync', period, data);
    expect(envelope).toMatchObject({ ok: true, command: 'sync' });
  });

  it('never prints a cursor, a token, a lease owner or a Drive name', async () => {
    const data = (await getSyncJobs(team))!;
    const text = JSON.stringify(data) + formatSyncJobs(data, resolvePeriod('7d', undefined));
    for (const secret of [
      'token-secret',
      'root-secret-id',
      'folder-secret-id',
      'other-secret-id',
      'Private Root Name',
      'dead-worker',
      'seed'
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(syncOutputIsPrivate(data)).toBe(true);
    expect(syncOutputIsPrivate({ cursor: 'x' })).toBe(false);
  });
});
