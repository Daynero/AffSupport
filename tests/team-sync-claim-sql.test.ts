import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (findings I1): the scheduler never hands a worker the job of a
 * detached connection. Before, it leased that job first (oldest by
 * next_attempt_at), the public wrapper dropped it after the lease, and the
 * live connection's initial scan starved behind a one-job slot.
 */

const OWNER = '24000000-0000-4000-8000-000000000001';

let harness: TeamTestDb;
let teamId: string;
let liveJob: string;
let deadJob: string;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@claim.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Claim']
  );
  teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-claim', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [OWNER]
  );
  const connection = async (state: 'detached' | 'connected', root: string) =>
    (
      await harness.root<{ id: string }>(
        `insert into public.team_drive_connections
           (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state,
            connected_at, detached_at)
         values ($1, $2, $3, $3, 'my_drive', $4, now() - interval '1 hour',
                 case when $4 = 'detached' then now() else null end)
         returning id`,
        [teamId, credential[0]!.id, root, state]
      )
    )[0]!.id;
  const job = async (connectionId: string, minutesAgo: number) =>
    (
      await harness.root<{ id: string }>(
        `insert into private.catalog_sync_jobs
           (connection_id, phase, cursor, folder_queue, state, next_attempt_at, created_at)
         values ($1, 'initial_scan', '{}'::jsonb, '[]'::jsonb, 'pending',
                 now() - make_interval(mins => $2), now() - make_interval(mins => $2))
         returning id`,
        [connectionId, minutesAgo]
      )
    )[0]!.id;
  // The detached connection's job is older, so it would be claimed first.
  deadJob = await job(await connection('detached', 'old-root'), 120);
  liveJob = await job(await connection('connected', 'new-root'), 1);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('claim_catalog_sync_jobs', () => {
  it('hands a one-job worker the live connection, not the detached one ahead of it', async () => {
    const claimed = await harness.root<{ id: string; state: string }>(
      `select id, state from private.claim_catalog_sync_jobs('worker-1', 1, 60)`
    );
    expect(claimed.map(row => row.id)).toEqual([liveJob]);
    const dead = await harness.root<{ state: string; attempts: number }>(
      'select state, attempts from private.catalog_sync_jobs where id = $1',
      [deadJob]
    );
    expect(dead[0]).toMatchObject({ state: 'pending', attempts: 0 });
  }, 60_000);

  /**
   * The same starvation one level down: a worker that dies inside its lease
   * writes nothing back, so the job used to keep the `next_attempt_at` it came
   * in with and win the single slot again the minute its lease expired. The
   * lease now moves it to the back, which is the only thing that lets whoever
   * was waiting have a turn.
   */
  it('sends a job whose worker never reported back to the back of the queue', async () => {
    const connected = (
      await harness.root<{ connection_id: string }>(
        'select connection_id from private.catalog_sync_jobs where id = $1',
        [liveJob]
      )
    )[0]!.connection_id;
    const queued = async (state: string, minutesAgo: number, leaseMinutesAgo: number | null) =>
      (
        await harness.root<{ id: string }>(
          `insert into private.catalog_sync_jobs
             (connection_id, phase, cursor, folder_queue, state, next_attempt_at, created_at,
              lease_owner, lease_expires_at, attempts)
           values ($1, 'incremental', '{}'::jsonb, '[]'::jsonb, $2,
                   now() - make_interval(mins => $3), now() - make_interval(mins => $3),
                   case when $4::int is null then null else 'worker-gone' end,
                   case when $4::int is null then null
                        else now() - make_interval(mins => $4::int) end,
                   0)
           returning id`,
          [connected, state, minutesAgo, leaseMinutesAgo]
        )
      )[0]!.id;
    // Abandoned two hours ago; waiting since one hour ago.
    const abandoned = await queued('leased', 120, 1);
    const waiting = await queued('pending', 60, null);

    // Its expired lease and older next_attempt_at put the abandoned job first.
    const first = await harness.root<{ id: string }>(
      `select id from private.claim_catalog_sync_jobs('worker-2', 1, 60)`
    );
    expect(first.map(row => row.id)).toEqual([abandoned]);

    // Abandoned again — nothing reports back — so the next tick must not repeat it.
    await harness.root(
      `update private.catalog_sync_jobs set lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [abandoned]
    );
    const second = await harness.root<{ id: string }>(
      `select id from private.claim_catalog_sync_jobs('worker-3', 1, 60)`
    );
    expect(second.map(row => row.id)).toEqual([waiting]);
  }, 60_000);
});

describe('service_request_catalog_rescan (011, findings I4)', () => {
  it('queues a full walk of the connected root for the owner and records it', async () => {
    const queued = await harness.root<{ job: string | null }>(
      'select public.service_request_catalog_rescan($1, $2) as job',
      [teamId, OWNER]
    );
    // The live connection's initial scan is still open (leased above), so that
    // walk is the answer rather than a second one queued behind it.
    expect(queued[0]!.job).toBe(liveJob);
    const job = await harness.root<{ phase: string; state: string }>(
      'select phase, state from private.catalog_sync_jobs where id = $1',
      [queued[0]!.job]
    );
    expect(job[0]).toMatchObject({ phase: 'initial_scan' });
    const connection = await harness.root<{ initial_sync_state: string }>(
      `select initial_sync_state from public.team_drive_connections
        where team_id = $1 and state = 'connected'`,
      [teamId]
    );
    expect(connection[0]!.initial_sync_state).toBe('scanning');
    const audit = await harness.root<{ action: string }>(
      `select action from public.team_audit_events where team_id = $1 and action = 'drive.resynced'`,
      [teamId]
    );
    expect(audit).toHaveLength(1);
    // Asked again while that scan is still queued: the same job, not a second one.
    const again = await harness.root<{ job: string | null }>(
      'select public.service_request_catalog_rescan($1, $2) as job',
      [teamId, OWNER]
    );
    expect(again[0]!.job).toBe(queued[0]!.job);
  }, 60_000);

  it('refuses anyone but the owner', async () => {
    await expect(
      harness.root('select public.service_request_catalog_rescan($1, $2)', [
        teamId,
        '24000000-0000-4000-8000-000000000009'
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  }, 60_000);
});

describe('multi-page lease ownership', () => {
  it('saves consecutive pages, excludes other workers, and resumes from the last saved page', async () => {
    await harness.root(`update private.catalog_sync_jobs set state = 'pending',
      lease_owner = null, lease_expires_at = null, next_attempt_at = now() + interval '1 hour'`);
    await harness.root(
      `update private.catalog_sync_jobs set next_attempt_at = now() where id = $1`,
      [liveJob]
    );
    await harness.root(`select id from private.claim_catalog_sync_jobs('scan', 1, 60)`);
    const save = (worker: string, page: string) =>
      harness.root<{ saved: boolean }>(
        `select public.service_save_catalog_sync_progress($1, $2, 'initial_scan', $3,
        'change-0', '["child"]'::jsonb, '[]'::jsonb) as saved`,
        [liveJob, worker, page]
      );
    expect((await save('scan', 'page-2'))[0]!.saved).toBe(true);
    expect(
      await harness.root(`select id from private.claim_catalog_sync_jobs('other', 1, 60)`)
    ).toEqual([]);
    expect((await save('other', 'wrong'))[0]!.saved).toBe(false);
    expect((await save('scan', 'page-3'))[0]!.saved).toBe(true);
    expect(
      (
        await harness.root<{ released: boolean }>(
          `select public.service_release_catalog_sync_job($1, 'scan') as released`,
          [liveJob]
        )
      )[0]!.released
    ).toBe(true);
    const resumed = await harness.root<{ cursor: { pageToken: string }; folder_queue: string[] }>(
      `select cursor, folder_queue from private.claim_catalog_sync_jobs('resumed', 1, 60)`
    );
    expect(resumed[0]).toMatchObject({ cursor: { pageToken: 'page-3' }, folder_queue: ['child'] });
    expect((await save('scan', 'stale'))[0]!.saved).toBe(false);
    await harness.root(
      `update private.catalog_sync_jobs set lease_expires_at = now() - interval '1 second' where id = $1`,
      [liveJob]
    );
    expect((await save('resumed', 'expired'))[0]!.saved).toBe(false);
  });

  it('caps active leases globally even when a caller asks for a large batch', async () => {
    await harness.root(`update private.catalog_sync_jobs set state = 'pending',
      lease_owner = null, lease_expires_at = null, next_attempt_at = now()`);
    const first = await harness.root(
      `select id from private.claim_catalog_sync_jobs('batch', 20, 60)`
    );
    expect(first).toHaveLength(3);
    expect(
      await harness.root(`select id from private.claim_catalog_sync_jobs('overflow', 20, 60)`)
    ).toEqual([]);
  });
});
