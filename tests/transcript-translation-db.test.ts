import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 063 on the real migration chain: the allowance can never be overspent, a failure gives the
 * minutes back, an attempt left running stops counting, the same text in the same language is
 * never paid for twice, and the cleanup fence still covers every table that references a file.
 */

const OWNER = '06300000-0000-4000-8000-00000000a001';
const OTHER = '06300000-0000-4000-8000-00000000a002';
const FP_A = `v1:${'a'.repeat(64)}`;
const FP_B = `v1:${'b'.repeat(64)}`;

let db: TeamTestDb;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner-063@example.test' });
  await createUser(db, { id: OTHER, email: 'other-063@example.test' });
}, 240_000);
afterAll(async () => db?.close());

async function begin(documentKey: string, fingerprint: string, units: number, target = 'uk') {
  const rows = await db.root<{ value: Record<string, unknown> }>(
    `select public.service_transcript_translation_begin(
       'personal', null, null, $1::uuid, $2, $3, 'tr', $4, 2, $5, $1::uuid) as value`,
    [OWNER, documentKey, fingerprint, target, units]
  );
  return rows[0]!.value;
}

async function used(user = OWNER): Promise<number> {
  const rows = await db.asUser<{ value: { usedUnits: number; limitUnits: number } }>(
    user,
    `select public.ai_allowance_status('transcript_translation') as value`
  );
  return rows[0]!.value.usedUnits;
}

describe('allowance', () => {
  it('starts every day at the full limit of 10 minutes', async () => {
    const rows = await db.asUser<{ value: Record<string, unknown> }>(
      OWNER,
      `select public.ai_allowance_status('transcript_translation') as value`
    );
    expect(rows[0]!.value).toMatchObject({ limitUnits: 9000, usedUnits: 0 });
    expect(String(rows[0]!.value.resetsAt)).toMatch(/T\d{2}:00:00Z$/u);
  });

  it('reserves, refuses what no longer fits, and gives a failure back', async () => {
    const first = await begin('doc-1', FP_A, 5000);
    expect(first).toMatchObject({ status: 'processing', reused: false });
    expect(await used()).toBe(5000);

    const again = await begin('doc-1', FP_A, 5000);
    expect(again).toMatchObject({ id: first.id, reused: true });
    expect(await used()).toBe(5000);

    await expect(begin('doc-2', FP_B, 5000)).rejects.toThrow(/ALLOWANCE_EXCEEDED/u);
    expect(await used()).toBe(5000);

    await db.root(`select public.service_transcript_translation_fail($1, 'TRANSLATION_REFUSED')`, [
      first.id
    ]);
    expect(await used()).toBe(0);
    const retried = await begin('doc-2', FP_B, 5000);
    expect(retried).toMatchObject({ status: 'processing', reused: false });
  });

  it('spends exactly once on success and replaces the older result of the language', async () => {
    const [row] = await db.root<{ id: string }>(
      `select id from private.transcript_translations where document_key = 'doc-2' and status = 'processing'`
    );
    await expect(
      db.root(
        `select public.service_transcript_translation_complete($1, array['only one'], 'claude-haiku-5-5')`,
        [row!.id]
      )
    ).rejects.toThrow(/INVALID_INPUT/u);
    await db.root(
      `select public.service_transcript_translation_complete($1, array['один','два'], 'claude-haiku-5-5')`,
      [row!.id]
    );
    await db.root(
      `select public.service_transcript_translation_complete($1, array['ще','раз'], 'claude-haiku-5-5')`,
      [row!.id]
    );
    expect(await used()).toBe(5000);
    const reused = await begin('doc-2', FP_B, 5000);
    expect(reused).toMatchObject({ id: row!.id, status: 'completed', reused: true });
    expect(await used()).toBe(5000);
  });

  it('stops counting an attempt left running and closes it as timed out', async () => {
    const started = await begin('doc-3', FP_A, 1000);
    expect(await used()).toBe(6000);
    await db.root(
      `update private.transcript_translations set created_at = now() - interval '6 minutes' where id = $1`,
      [started.id]
    );
    await db.root(
      `update private.ai_allowance_reservations set created_at = now() - interval '7 minutes'
        where id = (select reservation_id from private.transcript_translations where id = $1)`,
      [started.id]
    );
    expect(await used()).toBe(5000);
    const rows = await db.asUser<{ value: Record<string, unknown> }>(
      OWNER,
      `select public.get_transcript_translation($1) as value`,
      [started.id]
    );
    expect(rows[0]!.value).toMatchObject({ status: 'failed', failureCode: 'TRANSLATION_TIMEOUT' });
  });
});

describe('readers', () => {
  it('lists the owner’s texts by document or by the text itself, and hides them from others', async () => {
    const own = await db.asUser<{ value: { translations: Record<string, unknown>[] } }>(
      OWNER,
      `select public.list_personal_translations('other-computer', $1) as value`,
      [FP_B]
    );
    expect(own[0]!.value.translations).toEqual([
      expect.objectContaining({ status: 'completed', segments: ['один', 'два'] })
    ]);
    const foreign = await db.asUser<{ value: { translations: unknown[] } }>(
      OTHER,
      `select public.list_personal_translations('doc-2', $1) as value`,
      [FP_B]
    );
    expect(foreign[0]!.value.translations).toEqual([]);
    const [row] = await db.root<{ id: string }>(
      `select id from private.transcript_translations where document_key = 'doc-2'`
    );
    await expect(
      db.asUser(OTHER, `select public.get_transcript_translation($1)`, [row!.id])
    ).rejects.toThrow(/NOT_FOUND/u);
  });

  it('refuses a space the reader cannot view', async () => {
    await expect(
      db.asUser(
        OTHER,
        `select public.list_video_translations('06300000-0000-4000-8000-00000000c001', '06300000-0000-4000-8000-00000000c002')`
      )
    ).rejects.toThrow(/PERMISSION_DENIED/u);
  });
});

describe('deleting', () => {
  it('lets only the owner delete a transcriber translation, and removes the language', async () => {
    const [row] = await db.root<{ id: string }>(
      `select id from private.transcript_translations where document_key = 'doc-2' and status = 'completed'`
    );
    await expect(
      db.asUser(OTHER, `select public.delete_transcript_translation($1)`, [row!.id])
    ).rejects.toThrow(/NOT_FOUND/u);
    const done = await db.asUser<{ value: { deleted: number } }>(
      OWNER,
      `select public.delete_transcript_translation($1) as value`,
      [row!.id]
    );
    expect(done[0]!.value.deleted).toBeGreaterThan(0);
    const left = await db.root<{ n: number }>(
      `select count(*)::int as n from private.transcript_translations where document_key = 'doc-2' and target_language = 'uk'`
    );
    expect(left[0]!.n).toBe(0);
  });
});

describe('cleanup fence', () => {
  it('keeps attachment cleanup coverage verified with the new table', async () => {
    const rows = await db.root<{ verified: boolean }>(
      `select private.task_cleanup_coverage_verified() as verified`
    );
    expect(rows[0]!.verified).toBe(true);
  });
});
