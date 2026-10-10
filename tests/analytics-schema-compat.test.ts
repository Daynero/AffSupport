import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { getSchema } from '../scripts/analytics/schema';
import type {
  AuditData,
  InspectData,
  InvestigateData,
  JournalResult
} from '../scripts/analytics/types';

/**
 * The CLI runs against a database before and after the 031/033 migrations
 * (envelope v3 columns, daily rollups, agent journal). On the old schema every command still
 * succeeds and says what it could not read; on the new one nothing changes.
 */

const AS_OF = '2026-10-09T00:00:00Z';
const EMAIL = 'compat.user@example.test';
const USER = '0c000000-0000-4000-8000-000000000001';
const INSTALLATION = '1c000000-0000-4000-8000-000000000001';
const AGENT = '2c000000-0000-4000-8000-0000000000aa';
const RUN = '3c000000-0000-4000-8000-000000000001';
const ATTEMPT = 'find-attempt-1';

async function seed(db: AnalyticsTestDb, post031: boolean): Promise<void> {
  await db.exec(`
    insert into public.analytics_users (id, email, email_normalized, last_seen_at) values
      ('${USER}', '${EMAIL}', '${EMAIL}', '2026-10-05T10:05:00Z');
    insert into public.analytics_events
      (user_id, event_name, tool, run_id, installation_id, local_app_version, web_build_id,
       platform, error_code, error_stage, error_fingerprint, outcome, properties, occurred_at,
       created_at, session_sequence)
    values
      ('${USER}', 'operation_started', 'transcription', '${RUN}', '${INSTALLATION}', '1.2.6',
       '1.2.6', 'macos', null, null, null, null, '{}', '2026-10-05T10:00:00Z',
       '2026-10-05T10:00:00.200Z', 1),
      ('${USER}', 'error_occurred', 'transcription', '${RUN}', '${INSTALLATION}', '1.2.6',
       '1.2.6', 'macos', 'MODEL_MISSING', 'model', 'transcription:model:MODEL_MISSING',
       'failure', '{}', '2026-10-05T10:01:00Z', '2026-10-05T10:01:00.200Z', 2),
      ('${USER}', 'operation_failed', 'transcription', '${RUN}', '${INSTALLATION}', '1.2.6',
       '1.2.6', 'macos', null, null, null, 'failure', '{}', '2026-10-05T10:01:01Z',
       '2026-10-05T10:01:01.200Z', 3),
      ('${USER}', 'team_find_started', null, null, '${INSTALLATION}', '1.2.6', '1.2.6', 'macos',
       null, null, null, null, '{"attempt_id":"${ATTEMPT}","study_run_id":"s1","cue_category":"geo"}',
       '2026-10-05T11:00:00Z', '2026-10-05T11:00:00.200Z', 4);
  `);
  if (post031) {
    await db.exec(`
      update public.analytics_events set agent_instance_id = '${AGENT}', agent_platform = 'macos'
        where user_id = '${USER}';
      insert into public.agent_journal_records
        (user_id, installation_id, agent_instance_id, seq, recorded_at, received_at, category, code, props)
      values
        ('${USER}', '${INSTALLATION}', '${AGENT}', 1, '2026-10-05T10:00:30Z',
         '2026-10-05T10:00:31Z', 'spawn', 'started', '{"tool":"whisper"}');
    `);
  }
}

async function run(...argv: string[]) {
  return executeCommand(parseArgs([...argv, '--as-of', AS_OF, '--json']));
}

const COMMANDS: string[][] = [
  ['investigate', EMAIL, '--period', '30d'],
  ['journal', EMAIL],
  ['inspect', RUN],
  ['inspect', ATTEMPT],
  ['audit', '--period', '30d'],
  ['connection', '--period', '30d'],
  ['journey', EMAIL],
  ['errors', '--period', '30d'],
  ['overview', '--period', '30d']
];

describe.each([
  { label: 'pre-031 schema', schema: 'pre-031' as const, post031: false },
  { label: 'current schema', schema: 'current' as const, post031: true }
])('analytics CLI on the $label', ({ schema, post031 }) => {
  let db: AnalyticsTestDb;

  beforeAll(async () => {
    db = await createAnalyticsDb({ schema });
    await seed(db, post031);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('probes the schema once and reports what this database has', async () => {
    const probed = await getSchema();
    expect(probed.events).toEqual({
      attempt_id: post031,
      agent_instance_id: post031,
      agent_platform: post031
    });
    expect(probed.tables).toEqual({
      agent_journal_records: post031,
      analytics_daily_events: post031,
      analytics_daily_tool_outcomes: post031,
      analytics_catalog_sync_jobs: true
    });
    expect(await getSchema()).toBe(probed);
  });

  it.each(COMMANDS)('%s succeeds', async (...argv) => {
    const result = await run(...argv);
    expect(result.data).toBeDefined();
    expect(typeof result.human).toBe('string');
  });

  it('investigate names the missing sources only when they are missing', async () => {
    const data = (await run('investigate', EMAIL, '--period', '30d')).data as InvestigateData;
    const kinds = data.coverage.blind_spots.map(spot => spot.kind);
    expect(data.coverage.events).toBe(4);
    expect(data.operations.map(op => op.id)).toContain(RUN);
    expect(data.findings.some(f => f.fingerprint === 'transcription:model:MODEL_MISSING')).toBe(
      true
    );
    if (post031) {
      expect(kinds).not.toContain('journal_table_missing');
      expect(kinds).not.toContain('envelope_v3_missing');
      expect(data.schema.missing).toEqual([]);
      expect(data.coverage.journal_records).toBe(1);
      expect(data.subject.agent_instance_ids).toEqual([AGENT]);
    } else {
      expect(kinds).toContain('journal_table_missing');
      expect(kinds).toContain('envelope_v3_missing');
      // A journal that cannot be read is not reported as a journal that is empty.
      expect(kinds).not.toContain('agent_journal_missing');
      expect(kinds).not.toContain('agent_version_without_journal');
      expect(data.coverage.blind_spots.find(s => s.kind === 'envelope_v3_missing')?.values).toEqual(
        ['attempt_id', 'agent_instance_id', 'agent_platform']
      );
      expect(data.schema.missing).toEqual([
        'analytics_events.attempt_id',
        'analytics_events.agent_instance_id',
        'analytics_events.agent_platform',
        'agent_journal_records',
        'analytics_daily_events',
        'analytics_daily_tool_outcomes'
      ]);
      expect(data.coverage.journal_records).toBe(0);
      expect(data.subject.agent_instance_ids).toEqual([]);
      const journalFinding = data.findings.find(f => f.rule === 'journal_missing');
      expect(journalFinding?.evidence).toContain('blind_spot:journal_table_missing');
    }
  });

  it('investigate resolves an attempt id kept in properties', async () => {
    const data = (await run('investigate', ATTEMPT, '--period', '30d')).data as InvestigateData;
    expect(data.subject.kind).toBe('attempt');
    expect(data.subject.user_id).toBe(USER);
  });

  it('journal says it is unavailable instead of failing', async () => {
    const data = (await run('journal', EMAIL)).data as JournalResult;
    if (post031) {
      expect(data.available).toBe(true);
      expect(data.records).toHaveLength(1);
    } else {
      expect(data).toEqual({ available: false, reason: 'journal_table_missing', records: [] });
      const byId = (await run('journal', AGENT)).data as JournalResult;
      expect(byId.available).toBe(false);
    }
  });

  it('inspect finds the attempt either way and notes missing columns', async () => {
    const byRun = (await run('inspect', RUN)).data as InspectData;
    const byAttempt = (await run('inspect', ATTEMPT)).data as InspectData;
    expect(byRun.found).toBe(true);
    expect(byAttempt.found).toBe(true);
    if (!byRun.found || !byAttempt.found) throw new Error('inspect found nothing');
    expect(byAttempt.matched_by).toContain('attempt_id');
    if (post031) {
      expect(byRun.schema).toBeUndefined();
      expect(byRun.agent.agent_instance_ids).toEqual([AGENT]);
    } else {
      expect(byRun.schema?.missing).toEqual([
        'analytics_events.attempt_id',
        'analytics_events.agent_instance_id',
        'analytics_events.agent_platform'
      ]);
      expect(byRun.agent.agent_instance_ids).toEqual([]);
    }
  });

  it('audit reports the schema and notes what is missing', async () => {
    const data = (await run('audit', '--period', '30d')).data as AuditData;
    expect(data.capabilities.length).toBe(data.registry_size);
    if (post031) {
      expect(data.schema.missing).toEqual([]);
      expect(data.schema.note).toBeUndefined();
    } else {
      expect(data.schema.missing).toContain('analytics_events.attempt_id');
      expect(data.schema.missing).toContain('agent_journal_records');
      expect(data.schema.note).toMatch(/lacks/);
    }
  });
});

describe('analytics CLI without the sync jobs view', () => {
  let db: AnalyticsTestDb;

  beforeAll(async () => {
    db = await createAnalyticsDb({ schema: 'pre-031' });
    await seed(db, false);
    await db.exec('drop table public.analytics_catalog_sync_jobs;');
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('investigate reports sync_unavailable and audit still runs', async () => {
    const data = (await run('investigate', EMAIL, '--period', '30d')).data as InvestigateData;
    expect(data.sync.status).toBe('unavailable');
    expect(data.coverage.blind_spots.map(spot => spot.kind)).toContain('sync_unavailable');
    const audit = (await run('audit', '--period', '30d')).data as AuditData;
    expect(audit.schema.tables.analytics_catalog_sync_jobs).toBe(false);
    expect(audit.schema.missing).toContain('analytics_catalog_sync_jobs');
    const sync = audit.capabilities.find(c => c.source === 'authoritative_table');
    expect(sync).toMatchObject({ status: 'uncovered', missing: ['analytics_catalog_sync_jobs'] });
  });
});
