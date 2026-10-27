import { afterEach, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getTranslationRetirementEvidence } from '../scripts/analytics/library-retirement';
import { getInspect } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
const actor = '81000000-0000-4000-8000-000000000001';
const entity = '81000000-0000-4000-8000-000000000002';
const team = '81000000-0000-4000-8000-000000000003';
const asOf = '2026-10-27T12:00:00Z';
let db: AnalyticsTestDb;
afterEach(async () => {
  await db?.close();
});
async function setup() {
  db = await createAnalyticsDb({ schema: 'current' });
  await db.exec(`create table public.analytics_translation_retirement(entity_kind text,entity_id uuid,team_id uuid,actor_id uuid,requirement_id uuid,attempt_id uuid,operation_id uuid,state text,error_code text,created_at timestamptz,updated_at timestamptz,retirement_api_version int);
 insert into public.analytics_translation_retirement values('operation','${entity}','${team}','${actor}',null,null,'${entity}','canceled','FEATURE_RETIRED','2026-10-26T12:00Z','2026-10-27T11:00Z',6);
 insert into public.analytics_users(id,email,email_normalized) values('${actor}','retired@test.invalid','retired@test.invalid');`);
}
describe('retirement CLI projection', () => {
  it('reports a missing projection as unknown', async () => {
    db = await createAnalyticsDb({ schema: 'current' });
    expect(await getTranslationRetirementEvidence(entity, null, asOf)).toMatchObject({
      supported: false,
      rows: [],
      blind_spots: [expect.any(String)]
    });
  });
  it('joins a stored retirement into inspect and actor investigation without inventing delivery', async () => {
    await setup();
    const inspected = await getInspect(entity, asOf);
    expect(inspected).toMatchObject({
      found: true,
      last_proven_stage: 'server_retired',
      terminal: null,
      stages: { missing: ['result_visible'] },
      translation_retirement: { rows: [{ entity_id: entity, error_code: 'FEATURE_RETIRED' }] }
    });
    const result = await getInvestigation('retired@test.invalid', {
      label: '30d',
      token: '30d',
      start: '2026-09-27T12:00:00Z',
      end: asOf,
      as_of: asOf
    });
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'fact', rule: 'feature_retired' })])
    );
    expect(JSON.stringify(result)).not.toMatch(/retired@test|lease_token|expected_name/u);
  });
  it('bounds detail, preserves unknown actors and refuses changed-after-as-of history', async () => {
    await setup();
    await db.exec(
      `insert into public.analytics_translation_retirement select entity_kind,'81000000-0000-4000-8000-000000000004',team_id,null,null,null,null,state,error_code,created_at,'2026-10-27T13:00Z',retirement_api_version from public.analytics_translation_retirement;`
    );
    const bounded = await getTranslationRetirementEvidence(null, null, asOf, 'all', 1);
    expect(bounded.truncated).toBe(true);
    expect(bounded.rows).toEqual([]);
    expect(bounded.blind_spots.join(' ')).toContain('after as-of');
    const unknown = await getTranslationRetirementEvidence(null, null, asOf, 'actor');
    expect(unknown.rows).toEqual([]);
    expect(unknown.blind_spots.join(' ')).toContain('Unknown subject');
  });
});

it('carries an actual bounded producer through journal storage into inspect without browser events', async () => {
  await setup();
  const { DiagnosticsLog } = await import('../apps/agent/src/server/diagnostics-log');
  const { TranscriptionAttemptJournal } =
    await import('../apps/agent/src/transcription/diagnostics');
  const log = new DiagnosticsLog({ now: () => Date.parse('2026-10-27T11:00:00Z') });
  const producer = new TranscriptionAttemptJournal(entity, team, (code, props) => {
    log.record('transcription', code, props);
  });
  producer.stage('extract');
  producer.stage('transcribe');
  producer.stage('saved');
  producer.terminal('success');
  for (const record of log.since(0))
    await db.exec(
      `insert into public.agent_journal_records(user_id,agent_instance_id,seq,recorded_at,received_at,category,code,props) values('${actor}','${actor}',${record.seq},'2026-10-27T11:00Z','2026-10-27T11:01Z','transcription','${record.code}','${JSON.stringify(record.props)}');`
    );
  const inspected = await getInspect(team, asOf);
  expect(inspected).toMatchObject({
    found: true,
    last_proven_stage: 'saved',
    terminal: null,
    stages: { missing: ['result_visible'] },
    transcription_original: { attempts: [{ attempt_id: team, outcome: 'success' }] }
  });
  const investigation = await getInvestigation('retired@test.invalid', {
    token: '30d',
    label: '30d',
    start: '2026-09-27T12:00:00Z',
    end: asOf,
    as_of: asOf
  });
  expect(investigation.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: 'transcription_native_attempt', kind: 'fact' })
    ])
  );
});

it('joins a library attempt to native stages only through a matching actor and operation', async () => {
  await setup();
  const operation = '81000000-0000-4000-8000-000000000005';
  const nativeJob = '81000000-0000-4000-8000-000000000006';
  const nativeAttempt = '81000000-0000-4000-8000-000000000007';
  const libraryAttempt = '81000000-0000-4000-8000-000000000008';
  const { DiagnosticsLog } = await import('../apps/agent/src/server/diagnostics-log');
  const { TranscriptionAttemptJournal } =
    await import('../apps/agent/src/transcription/diagnostics');
  const log = new DiagnosticsLog({ now: () => Date.parse('2026-10-27T11:00Z') });
  const producer = new TranscriptionAttemptJournal(
    nativeJob,
    nativeAttempt,
    (code, props) => {
      log.record('transcription', code, props);
    },
    operation
  );
  producer.stage('saved');
  producer.terminal('success');
  for (const record of log.since(0))
    await db.exec(
      `insert into public.agent_journal_records(user_id,agent_instance_id,seq,recorded_at,received_at,category,code,props) values('${actor}','${actor}',${record.seq},'2026-10-27T11:00Z','2026-10-27T11:01Z','transcription','${record.code}','${JSON.stringify(record.props)}');`
    );
  await db.exec(
    `insert into public.analytics_events(user_id,event_name,tool,run_id,attempt_id,occurred_at,created_at,properties) values('${actor}','operation_stage_completed',null,'${operation}','${libraryAttempt}','2026-10-27T11:01Z','2026-10-27T11:02Z','{"flow_step":"library_original_processing","action_identifier":"registered"}');`
  );
  const bound = await getInspect(libraryAttempt, asOf);
  expect(bound).toMatchObject({
    found: true,
    transcription_original: { attempts: [{ attempt_id: nativeAttempt, outcome: 'success' }] }
  });
  await db.exec(
    `update public.agent_journal_records set user_id='81000000-0000-4000-8000-000000000009';`
  );
  const foreign = await getInspect(libraryAttempt, asOf);
  expect(foreign).toMatchObject({ found: true, transcription_original: { attempts: [] } });
});
