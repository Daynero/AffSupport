import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { sanitizeJournalProps } from '../scripts/analytics/investigate';
import { investigateOutputIsPrivate, type JournalData } from '../scripts/analytics/types';

/**
 * 033 T009 / FR-006 — `journal <email | installation_id | agent_instance_id>`: the agent's
 * journal records the web forwarded, oldest first, with the agent run, both clocks and the lag,
 * bounded by the period and pinned by `--as-of`. The email resolves the user and is never
 * printed; props pass the server fence again.
 */

const AS_OF = '2026-10-09T00:00:00Z';
const USER = '0b000000-0000-4000-8000-000000000001';
const OTHER = '0b000000-0000-4000-8000-000000000002';
const INSTALLATION = '1c000000-0000-4000-8000-000000000001';
const RUN_A = '2d000000-0000-4000-8000-00000000000a';
const RUN_B = '2d000000-0000-4000-8000-00000000000b';
const RUN_OTHER = '2d000000-0000-4000-8000-00000000000c';

let db: AnalyticsTestDb;

beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into public.analytics_users (id, email, email_normalized) values
      ('${USER}', 'Journal.User@example.test', 'journal.user@example.test'),
      ('${OTHER}', 'other@example.test', 'other@example.test');
    insert into public.agent_journal_records
      (user_id, installation_id, agent_instance_id, seq, recorded_at, received_at, category, code, props)
    values
      -- Outside the 30-day window.
      ('${USER}', '${INSTALLATION}', '${RUN_A}', 1, '2026-08-01T10:00:00Z', '2026-08-01T10:00:02Z', 'boot', 'started', '{}'),
      -- Agent run A, then a restart (run B) whose seq starts again at 1.
      ('${USER}', '${INSTALLATION}', '${RUN_A}', 7, '2026-10-05T10:00:00Z', '2026-10-05T10:00:03Z', 'spawn', 'started', '{"tool":"ffmpeg"}'),
      ('${USER}', '${INSTALLATION}', '${RUN_A}', 8, '2026-10-05T10:00:05Z', '2026-10-05T10:00:06Z', 'spawn', 'exited', '{"tool":"ffmpeg","outcome":"nonzero","duration":"lt_10s"}'),
      ('${USER}', '${INSTALLATION}', '${RUN_B}', 1, '2026-10-05T10:05:00Z', '2026-10-05T10:05:01Z', 'boot', 'started', '{"platform":"macos"}'),
      ('${USER}', '${INSTALLATION}', '${RUN_B}', 2, '2026-10-05T10:06:00Z', '2026-10-05T10:06:00.500Z', 'picker', 'exit', '{"kind":"file","outcome":"failed","note":"Bearer abc","where":"/Users/a/b.mov","mail":"a@b.c"}'),
      -- Received after the as-of instant: invisible to a pinned read.
      ('${USER}', '${INSTALLATION}', '${RUN_B}', 3, '2026-10-08T23:59:00Z', '2026-10-09T00:00:30Z', 'stream', 'evict', '{"reason":"stalled"}'),
      -- Someone else's run.
      ('${OTHER}', null, '${RUN_OTHER}', 1, '2026-10-05T10:00:00Z', '2026-10-05T10:00:01Z', 'boot', 'started', '{}');
  `);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function journal(subject: string, ...extra: string[]): Promise<JournalData> {
  const result = await executeCommand(
    parseArgs(['journal', subject, '--as-of', AS_OF, '--json', ...extra])
  );
  return result.data as JournalData;
}

describe('journal · by email', () => {
  it('returns the user records in the period, oldest first, with both clocks and the lag', async () => {
    const data = await journal('journal.user@example.test');
    expect(data.subject).toEqual({
      kind: 'user',
      user_id: USER,
      installation_id: null,
      agent_instance_id: null
    });
    expect(
      data.records.map(r => `${r.agent_instance_id.slice(-1)}#${r.seq} ${r.category}:${r.code}`)
    ).toEqual(['a#7 spawn:started', 'a#8 spawn:exited', 'b#1 boot:started', 'b#2 picker:exit']);
    expect(data.records[1]).toMatchObject({
      recorded_at: '2026-10-05T10:00:05.000Z',
      received_at: '2026-10-05T10:00:06.000Z',
      lag_ms: 1000,
      installation_id: INSTALLATION,
      props: { tool: 'ffmpeg', outcome: 'nonzero', duration: 'lt_10s' }
    });
    expect(data.total).toBe(4);
    expect(data.truncated).toBe(false);
    expect(data.lag_ms).toEqual({ p50: 1000, p95: 2700, samples: 4 });
  });

  it('matches the email case-insensitively and never prints it', async () => {
    const result = await executeCommand(
      parseArgs(['journal', 'JOURNAL.USER@example.test', '--as-of', AS_OF])
    );
    expect((result.data as JournalData).records).toHaveLength(4);
    expect(result.human).not.toContain('@');
    expect(JSON.stringify(result.data)).not.toContain('@');
  });

  it('drops every prop the server fence would refuse', async () => {
    const data = await journal('journal.user@example.test');
    expect(data.records[3].props).toEqual({ kind: 'file', outcome: 'failed' });
    expect(investigateOutputIsPrivate(data)).toBe(true);
    expect(
      sanitizeJournalProps({ a: 'x://y', b: 'tok_token', c: 1, d: true, 'bad key': 1 })
    ).toEqual({
      c: 1,
      d: true
    });
  });
});

describe('journal · by id, period and limit', () => {
  it('accepts an agent instance id and an installation id', async () => {
    const byRun = await journal(RUN_B);
    expect(byRun.subject.kind).toBe('agent_instance');
    expect(byRun.records.map(r => r.seq)).toEqual([1, 2]);
    const byInstallation = await journal(INSTALLATION);
    expect(byInstallation.subject.kind).toBe('installation');
    expect(byInstallation.records).toHaveLength(4);
  });

  it('keeps the newest records within --limit and says so', async () => {
    const data = await journal('journal.user@example.test', '--limit', '2');
    expect(data.records.map(r => `${r.category}:${r.code}`)).toEqual([
      'boot:started',
      'picker:exit'
    ]);
    expect(data.total).toBe(4);
    expect(data.truncated).toBe(true);
  });

  it('honours --period and --as-of', async () => {
    const all = await journal('journal.user@example.test', '--period', 'all');
    expect(all.records.map(r => r.seq)).toEqual([1, 7, 8, 1, 2]);
    const later = await executeCommand(
      parseArgs([
        'journal',
        'journal.user@example.test',
        '--as-of',
        '2026-10-10T00:00:00Z',
        '--json'
      ])
    );
    expect((later.data as JournalData).records.at(-1)).toMatchObject({
      category: 'stream',
      code: 'evict'
    });
  });

  it('refuses a subject it cannot resolve', async () => {
    await expect(journal('nobody@example.test')).rejects.toThrow('No user found for that email.');
    await expect(journal('99999999-0000-4000-8000-000000000000')).rejects.toThrow(
      /No agent journal record/
    );
    await expect(journal('not-an-id')).rejects.toThrow(/journal takes/);
  });

  it('prints a human table', async () => {
    const result = await executeCommand(parseArgs(['journal', RUN_A, '--as-of', AS_OF]));
    expect(result.human).toContain('Agent journal');
    expect(result.human).toContain('spawn:exited');
  });
});
