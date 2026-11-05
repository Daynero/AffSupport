import { setQueryExecutor } from '../scripts/analytics/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getInspect } from '../scripts/analytics/queries';
import {
  getTeamProcessJournalEvidence,
  mergeTeamProcessJournal
} from '../scripts/analytics/team-process-journal';
import type { InspectFound } from '../scripts/analytics/types';
let db: AnalyticsTestDb;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE = '52180dea-de93-485e-9928-82d4f1ea68d5';
const OP = 'aa66028f-61ad-4d19-ae79-5f46feee14a7';
const SECOND = 'd97a7dda-9fe9-4350-a81a-8eec64dd0d65';
beforeAll(async () => {
  db = await createAnalyticsDb();
  for (const [index, operationId] of [OP, SECOND].entries()) {
    await db.db.query(
      `insert into public.agent_journal_records
      (user_id, agent_instance_id, seq, recorded_at, received_at, category, code, props)
      values($1,$2,$3,'2026-11-05T11:44:58Z','2026-11-05T11:45:00Z','team','process_terminal',$4)`,
      [
        USER,
        INSTANCE,
        index + 1,
        JSON.stringify({
          operationId,
          tool: 'restitch',
          stage: 'processing',
          outcome: 'failed',
          errorCode: 'RESTITCH_SCREEN_FETCH_FAILED'
        })
      ]
    );
  }
}, 30000);
afterAll(async () => {
  await db.close();
});
it.each([OP, SECOND])(
  'explains native-only failure %s without a browser terminal',
  async operationId => {
    const result = await getInspect(operationId, '2026-11-05T12:00:00Z');
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('native operation missing');
    expect(result.terminal).toMatchObject({
      event: 'journal:team:process_terminal',
      outcome: 'failure'
    });
    expect(result.team_native?.records[0].error_code).toBe('RESTITCH_SCREEN_FETCH_FAILED');
    expect(result.stages.missing).toContain('result_visible');
  }
);
it('does not mistake an execution reservation for the final native outcome', async () => {
  const evidence = await getTeamProcessJournalEvidence(OP, '2026-11-05T12:00:00Z');
  const base: InspectFound = {
    found: true,
    id: OP,
    capability: 'team.tariff_recovery',
    tool: 'team',
    matched_by: ['authoritative_table'],
    stages: {
      expected: ['reservation', 'settlement'],
      observed: ['reservation'],
      missing: ['settlement']
    },
    terminal: null,
    last_proven_stage: 'reservation',
    first_seen_at: null,
    last_seen_at: null,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    events: [],
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: 'unknown'
    }
  };
  const result = mergeTeamProcessJournal(base, evidence);
  expect(result.found && result.terminal?.outcome).toBe('failure');
  expect(result.found && result.stages.missing).toContain('settlement');
});
it('keeps late journal delivery outside an earlier as-of cutoff', async () => {
  const result = await getTeamProcessJournalEvidence(OP, '2026-11-05T11:44:59Z');
  expect(result.records).toEqual([]);
});
it('does not infer a single terminal from conflicting native reports', () => {
  const records = [
    {
      agent_instance_id: INSTANCE,
      seq: 1,
      at: '2026-11-05T11:44:58Z',
      stage: 'processing',
      outcome: 'failure' as const,
      error_code: 'RESTITCH_SCREEN_FETCH_FAILED'
    },
    {
      agent_instance_id: INSTANCE,
      seq: 2,
      at: '2026-11-05T11:44:59Z',
      stage: 'processing',
      outcome: 'cancelled' as const,
      error_code: 'PROCESS_CANCELED'
    }
  ];
  const result = mergeTeamProcessJournal(
    { found: false, id: OP },
    { supported: true, truncated: false, records, blind_spots: [] }
  );
  expect(result.found && result.terminal).toBeNull();
  expect(result.found && result.team_native?.blind_spots.join(' ')).toContain('Conflicting');
});

it('exposes a browser/native contradiction without choosing a successful outcome', async () => {
  const evidence = await getTeamProcessJournalEvidence(OP, '2026-11-05T12:00:00Z');
  const native = mergeTeamProcessJournal({ found: false, id: OP }, evidence);
  if (!native.found) throw new Error('missing native operation');
  const result = mergeTeamProcessJournal(
    {
      ...native,
      terminal: {
        event: 'team_file_attempt_completed',
        outcome: 'success',
        occurred_at: '2026-11-05T11:45:00Z'
      }
    },
    evidence
  );
  expect(result.found && result.terminal).toBeNull();
  expect(result.found && result.team_native?.blind_spots.join(' ')).toContain(
    'Conflicting browser/server'
  );
  expect(evidence.blind_spots).toEqual([]);
});

it.each(['57014', '42501', '42703'])(
  'does not lose other inspect evidence when the native journal source is unavailable (%s)',
  async code => {
    setQueryExecutor(async (sql, params) => {
      if (sql.includes("code='process_terminal'"))
        throw Object.assign(new Error('private provider payload'), { code });
      const result = await db.db.query(sql, params);
      return result.rows as Record<string, unknown>[];
    });
    const evidence = await getTeamProcessJournalEvidence(OP, '2026-11-05T12:00:00Z');
    expect(evidence.records).toEqual([]);
    expect(evidence.blind_spots.join(' ')).toContain('source unavailable');
    const result = mergeTeamProcessJournal({ found: false, id: OP }, evidence);
    expect(result.found).toBe(false);
    expect(result.team_native?.blind_spots.join(' ')).toContain('unknown');
    expect(JSON.stringify(result)).not.toContain('private provider payload');
  }
);
