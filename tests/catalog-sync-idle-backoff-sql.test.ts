import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * perf 1.4.3 (20261207399700): an idle space's Drive feed backs off.
 * A pass whose change token did not move doubles the wait (1 -> 2 -> 4 -> 8 ->
 * 10 minutes at most); a pass that moves it returns to 1 minute; an open space
 * (wake_team_catalog_sync) and a resync nudge poll it at once.
 */
const owner = '39970000-0000-4000-8000-000000000001';
const outsider = '39970000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let credential: string;
let counter = 0;

async function connect(): Promise<{ team: string; connection: string; feed: string }> {
  counter += 1;
  const [team] = await db.asUser<{ id: string }>(owner, 'select id from public.create_team($1)', [
    `Idle ${counter}`
  ]);
  const [connection] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, change_page_token)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', 'token-0') returning id`,
    [team!.id, credential]
  );
  // A finite job makes the trigger create the connection's canonical feed
  // (as in tests/fixtures/catalog-sync.ts); it is then put out of the way.
  const [finite] = await db.root<{ id: string }>(
    `insert into private.catalog_sync_jobs
      (connection_id, job_kind, phase, cursor, folder_queue, requested_folder_id, next_attempt_at)
     values ($1, 'user_subtree', 'initial_scan', '{"changePageToken":"seed"}', '["seed"]'::jsonb, 'seed',
       now() + interval '1 day') returning id`,
    [connection!.id]
  );
  await db.root(
    "update private.catalog_sync_jobs set state = 'succeeded', completed_at = now() where id = $1",
    [finite!.id]
  );
  const [feed] = await db.root<{ id: string }>(
    "select id from private.catalog_sync_jobs where connection_id = $1 and job_kind = 'incremental'",
    [connection!.id]
  );
  return { team: team!.id, connection: connection!.id, feed: feed!.id };
}

/** One worker pass of the feed that ends on `token`; returns the wait it scheduled, in minutes. */
async function pass(connection: string, feed: string, token: string): Promise<number> {
  await db.root(
    `update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
     where connection_id <> $1 and state in ('pending', 'retry')`,
    [connection]
  );
  await db.root(
    "update private.catalog_sync_jobs set state = 'pending', next_attempt_at = now() - interval '1 second' where id = $1",
    [feed]
  );
  const [lease] = await db.root<{ job_id: string; lease_epoch: number }>(
    "select job_id, lease_epoch from public.service_claim_catalog_sync_work('feed', 1, 60)"
  );
  expect(lease?.job_id).toBe(feed);
  const [saved] = await db.root<{ ok: boolean }>(
    "select public.service_complete_catalog_sync_job($1, 'feed', $2::bigint, $3) as ok",
    [feed, lease!.lease_epoch, token]
  );
  expect(saved?.ok).toBe(true);
  return waitOf(feed);
}

async function waitOf(feed: string): Promise<number> {
  const [row] = await db.root<{ minutes: number }>(
    'select round(extract(epoch from next_attempt_at - clock_timestamp()) / 60)::integer as minutes from private.catalog_sync_jobs where id = $1',
    [feed]
  );
  return row!.minutes;
}

const idlePolls = async (feed: string) =>
  (
    await db.root<{ idle_polls: number }>(
      'select idle_polls from private.catalog_sync_jobs where id = $1',
      [feed]
    )
  )[0]!.idle_polls;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'idle-owner@example.test' });
  await createUser(db, { id: outsider, email: 'idle-outsider@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [row] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('idle', 'idle@example.test', 'https://www.googleapis.com/auth/drive.file', gen_random_uuid(), $1)
     returning id`,
    [owner]
  );
  credential = row!.id;
}, 240_000);
afterAll(async () => {
  await db?.close();
});

describe('idle Drive feed backoff', () => {
  it('doubles the wait while the token stands still, caps it at 10 minutes, and drops to 1 on a change', async () => {
    const { connection, feed } = await connect();
    expect(await pass(connection, feed, 'token-1')).toBe(1);
    expect(await pass(connection, feed, 'token-1')).toBe(2);
    expect(await pass(connection, feed, 'token-1')).toBe(4);
    expect(await pass(connection, feed, 'token-1')).toBe(8);
    expect(await pass(connection, feed, 'token-1')).toBe(10);
    expect(await pass(connection, feed, 'token-1')).toBe(10);
    expect(await idlePolls(feed)).toBe(4);
    expect(await pass(connection, feed, 'token-2')).toBe(1);
    expect(await idlePolls(feed)).toBe(0);
  });

  it('wakes an idle feed for a member who opens the space, once, and refuses outsiders', async () => {
    const { team, connection, feed } = await connect();
    await pass(connection, feed, 'token-a');
    expect(await pass(connection, feed, 'token-a')).toBe(2);

    await expect(
      db.asUser(outsider, 'select public.wake_team_catalog_sync($1) as woke', [team])
    ).rejects.toThrow(/PERMISSION_DENIED/);

    const [first] = await db.asUser<{ woke: boolean }>(
      owner,
      'select public.wake_team_catalog_sync($1) as woke',
      [team]
    );
    expect(first?.woke).toBe(true);
    expect(await waitOf(feed)).toBeLessThanOrEqual(0);
    expect(await idlePolls(feed)).toBe(0);

    // A feed on its normal cadence is left alone: repeated opens cost no write.
    const [again] = await db.asUser<{ woke: boolean }>(
      owner,
      'select public.wake_team_catalog_sync($1) as woke',
      [team]
    );
    expect(again?.woke).toBe(false);
  });

  it('a resync nudge resets the backoff', async () => {
    const { connection, feed } = await connect();
    await pass(connection, feed, 'token-n');
    await pass(connection, feed, 'token-n');
    expect(await pass(connection, feed, 'token-n')).toBe(4);
    await db.root('select private.nudge_catalog_sync_feed($1)', [connection]);
    expect(await waitOf(feed)).toBeLessThanOrEqual(0);
    expect(await idlePolls(feed)).toBe(0);
  });
});
