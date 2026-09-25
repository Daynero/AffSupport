import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createTeamTestDb, createUser } from './support/team-db';

it('retires ambiguous legacy cursors and live leases before enforcing singleton ownership', async () => {
  const db = await createTeamTestDb({
    throughMigration: '20260922190000_folder_resync_completion.sql'
  });
  try {
    const owner = '26100000-0000-4000-8000-000000000001';
    await createUser(db, { id: owner, email: 'backfill@example.test' });
    await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
    const [team] = await db.asUser<{ id: string }>(
      owner,
      "select id from public.create_team('Backfill')"
    );
    const [credential] = await db.root<{ id: string }>(
      `insert into private.google_drive_credentials
      (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
      values ('backfill', 'backfill@example.test', 'https://www.googleapis.com/auth/drive.file', gen_random_uuid(), $1)
      returning id`,
      [owner]
    );
    const [connection] = await db.root<{ id: string }>(
      `insert into public.team_drive_connections
      (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, change_page_token)
      values ($1, $2, 'root', 'Root', 'my_drive', 'connected', 'zzz-unknown-writer') returning id`,
      [team!.id, credential!.id]
    );
    await db.root(
      `insert into private.catalog_sync_jobs(connection_id, phase, cursor, state, lease_owner, lease_expires_at)
      values ($1, 'incremental', '{"changePageToken":"aaa-newer-but-not-sortable"}', 'leased', 'old-worker', now() + interval '1 hour'),
      ($1, 'incremental', '{"changePageToken":"999"}', 'pending', null, null)`,
      [connection!.id]
    );
    await db.root(
      `insert into public.team_materials(team_id, connection_id, drive_file_id, name, kind)
      values ($1, $2, 'known', 'Keep me', 'file')`,
      [team!.id, connection!.id]
    );
    await db.db.exec(
      readFileSync('supabase/migrations/20260924100000_catalog_sync_ownership.sql', 'utf8')
    );
    expect(
      await db.root(
        'select confirmed_cursor, bootstrap_required from private.catalog_sync_authority'
      )
    ).toEqual([{ confirmed_cursor: null, bootstrap_required: true }]);
    expect(
      await db.root(
        "select count(*)::int as count from private.catalog_sync_jobs where state = 'canceled'"
      )
    ).toEqual([{ count: 2 }]);
    expect(
      await db.root(
        "select count(*)::int as count from private.catalog_sync_jobs where job_kind = 'incremental' and state = 'pending'"
      )
    ).toEqual([{ count: 1 }]);
    expect(
      await db.root(
        "select cursor, folder_queue from private.catalog_sync_jobs where job_kind = 'reconcile'"
      )
    ).toEqual([{ cursor: {}, folder_queue: ['root'] }]);
    expect(await db.root('select name, lifecycle from public.team_materials')).toEqual([
      { name: 'Keep me', lifecycle: 'active' }
    ]);
    const [claim] = await db.root<{ job_id: string; lease_epoch: number }>(
      "select * from public.service_claim_catalog_sync_work('new-worker', 1, 60)"
    );
    expect(
      await db.root(
        "select public.service_bootstrap_catalog_sync($1, 'new-worker', $2, 'fresh-provider-position') as ok",
        [claim!.job_id, claim!.lease_epoch]
      )
    ).toEqual([{ ok: true }]);
    expect(
      await db.root(
        'select confirmed_cursor, bootstrap_required from private.catalog_sync_authority'
      )
    ).toEqual([{ confirmed_cursor: null, bootstrap_required: false }]);
    expect(
      await db.root(
        "select distinct cursor ->> 'changePageToken' as token from private.catalog_sync_jobs where state in ('pending', 'leased')"
      )
    ).toEqual([{ token: 'fresh-provider-position' }]);
  } finally {
    await db.close();
  }
}, 60_000);
