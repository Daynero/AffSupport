import { readFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import {
  closeTransferGrantDatabase,
  ticketHash,
  transferGrantSuite
} from './support/adversarial/transfer-grants.js';

afterAll(closeTransferGrantDatabase);

it('drains only old expired tickets in bounded batches and preserves live transfers', async () => {
  const target = await transferGrantSuite.start();
  try {
    const old = await target.issue({});
    const recent = await target.issue({});
    const live = await target.issue({});
    await target.db.query(
      `
      update private.team_transfer_grants set created_at = now() - interval '4 days',
        expires_at = now() - interval '2 days' where token_hash = $1::text::bytea
    `,
      [ticketHash(old)]
    );
    await target.db.query(
      `
      update private.team_transfer_grants set created_at = now() - interval '2 hours',
        expires_at = now() - interval '1 hour' where token_hash = $1::text::bytea
    `,
      [ticketHash(recent)]
    );
    await target.db.exec(
      await readFile('supabase/migrations/20261202121000_transfer_grant_retention.sql', 'utf8')
    );
    expect(
      (
        await target.db.query<{ old_index: string | null }>(
          "select to_regclass('private.team_transfer_grants_expiry_idx')::text as old_index"
        )
      ).rows[0]?.old_index
    ).toBeNull();
    expect(
      (
        await target.db.query<{ removed: number }>(
          'select private.cleanup_team_transfer_grants(1) as removed'
        )
      ).rows[0]?.removed
    ).toBe(1);
    expect(
      (
        await target.db.query<{ removed: number }>(
          'select private.cleanup_team_transfer_grants() as removed'
        )
      ).rows[0]?.removed
    ).toBe(0);
    expect(await target.consume(recent, 'preview_range')).toBeNull();
    expect((await target.range(live)).refused).toBe(false);
    expect(
      (await target.db.query('select id from private.team_transfer_grants')).rows
    ).toHaveLength(2);
    await target.db.exec(`
      insert into private.team_transfer_grants (
        token_hash, team_id, actor_id, purpose, max_range_bytes, expires_at, created_at
      ) select decode(md5(i::text) || md5(i::text), 'hex'), team_id, actor_id,
        purpose, max_range_bytes, now() - interval '2 days', now() - interval '3 days'
      from private.team_transfer_grants cross join generate_series(1, 501) i
      where token_hash = '${ticketHash(recent)}'::bytea
    `);
    expect(
      (
        await target.db.query<{ removed: number }>(
          'select private.cleanup_team_transfer_grants(10000) as removed'
        )
      ).rows[0]?.removed
    ).toBe(500);
    expect(
      (
        await target.db.query<{ allowed: boolean }>(
          "select has_function_privilege('service_role', 'private.cleanup_team_transfer_grants(integer)', 'EXECUTE') as allowed"
        )
      ).rows[0]?.allowed
    ).toBe(false);
  } finally {
    await target.stop();
  }
});
