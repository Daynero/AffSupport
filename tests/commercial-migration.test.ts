import { setQueryExecutor } from '../scripts/analytics/db';
import { getCommercialAccessEvidence } from '../scripts/analytics/commercial-access';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTeamTestDb, createUser } from './support/team-db';

it('migrates old over-capacity teams and reserves legacy Google identities before token deletion', async () => {
  const db = await createTeamTestDb({
    throughMigration: '20261207103000_catalog_schedule_timezone_lookup.sql'
  });
  try {
    const admin = randomUUID(),
      owner = randomUUID(),
      ambiguous = randomUUID();
    for (const [id, email] of [
      [admin, 'migration-admin@test.invalid'],
      [owner, 'payer@test.invalid'],
      [ambiguous, 'ambiguous@test.invalid']
    ])
      await createUser(db, { id, email });
    await db.root('insert into public.admin_users(user_id) values($1)', [admin]);
    // Historical API is intentional: reproduce the schema and data before this migration.
    await db.asUser(
      admin,
      "select public.admin_grant_space_tariff('payer@test.invalid','lead',private.kyiv_today()+30,0)"
    );
    const [{ id: team }] = await db.asUser<{ id: string }>(
      owner,
      "select id from public.create_team('Old capacity')"
    );
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await createUser(db, { id, email: `old-pupil-${i}@test.invalid` });
      await db.root(
        "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
        [team, id]
      );
    }
    const [{ id: credential }] = await db.root<{ id: string }>(
      "select private.upsert_google_drive_credential($1,'old-drive','old-drive@test.invalid','https://www.googleapis.com/auth/drive.file','synthetic-refresh-token-sixteen') id",
      [owner]
    );
    for (const principal of ['ambiguous-a', 'ambiguous-b'])
      await db.root(
        "select private.upsert_google_drive_credential($1,$2,$3,'https://www.googleapis.com/auth/drive.file','synthetic-refresh-token-sixteen')",
        [ambiguous, principal, `${principal}@test.invalid`]
      );
    await db.db.exec(
      readFileSync(
        'supabase/migrations/20261207110000_commercial_access_guards.sql',
        'utf8'
      ).replaceAll('extensions.citext', 'text')
    );
    const [capacity] = await db.root<{ limit: number; used: number }>(
      'select private.team_seat_limit($1) as limit,private.team_seats_used($1) used',
      [team]
    );
    expect(capacity).toEqual({ limit: 3, used: 4 });
    await expect(
      db.asUser(
        owner,
        "select * from public.create_invitation($1,'no-room@test.invalid','editor',decode(repeat('ab',32),'hex'))",
        [team]
      )
    ).rejects.toThrow('SEATS_FULL');
    await db.root('select public.service_delete_google_drive_credential($1)', [credential]);
    await expect(
      db.root(
        "select public.service_store_google_drive_credential($1,'new-drive','payer@test.invalid','https://www.googleapis.com/auth/drive.file','synthetic-refresh-token-sixteen')",
        [owner]
      )
    ).rejects.toThrow('GOOGLE_ACCOUNT_NOT_APPROVED');
    await expect(
      db.root(
        "select public.service_store_google_drive_credential($1,'old-drive','old-drive@test.invalid','https://www.googleapis.com/auth/drive.file','synthetic-refresh-token-sixteen')",
        [owner]
      )
    ).resolves.toHaveLength(1);
    expect(
      (
        await db.root<{ needs_review: boolean }>(
          'select needs_review from private.commercial_google_principals where actor_id=$1',
          [ambiguous]
        )
      )[0].needs_review
    ).toBe(true);
    setQueryExecutor(async (sql, params) => db.root(sql, [...params]));
    const evidence = await getCommercialAccessEvidence(owner, null, new Date().toISOString());
    expect(evidence.supported).toBe(true);
    expect(
      evidence.records.some(
        record =>
          record.kind === 'migration_capacity_review' &&
          record.seats_total === 3 &&
          record.seats_used === 4
      )
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('@test.invalid');
    const pending = await getCommercialAccessEvidence(ambiguous, null, new Date().toISOString());
    expect(
      pending.records.some(record => record.kind === 'google_approval' && record.needs_review)
    ).toBe(true);
    expect(
      (await getCommercialAccessEvidence(owner, null, '2000-01-01T00:00:00Z')).records
    ).toEqual([]);
    expect(
      (
        await db.root<{ allowed: boolean }>(
          "select has_table_privilege('authenticated','public.analytics_commercial_access','select') allowed"
        )
      )[0].allowed
    ).toBe(false);
  } finally {
    setQueryExecutor(null);
    await db.close();
  }
}, 120_000);
