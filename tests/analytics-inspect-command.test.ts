import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { formatInspect } from '../scripts/analytics/format';
import { getInspect } from '../scripts/analytics/queries';
import type { InspectData, InspectFound } from '../scripts/analytics/types';

/**
 * 031 T019 — `inspect <id>` reconstructs one attempt from every event that
 * carries the id in a correlation column or property, oldest first, with the
 * stages the coverage registry expected for that capability.
 */

let db: AnalyticsTestDb;
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = '20000000-0000-4000-8000-000000000001';
const FLOW = '30000000-0000-4000-8000-000000000001';
const ATTEMPT = 'att_7f3a';
const WORKFLOW = 'wf_01';
// Envelope v3 (031 T012): the id in its own column, and the Agent's run and platform.
const ATTEMPT_V3 = 'att_v3_01';
const RUN_V3 = '20000000-0000-4000-8000-000000000002';
const INSTANCE_A = '50000000-0000-4000-8000-00000000000a';
const INSTANCE_B = '50000000-0000-4000-8000-00000000000b';

beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into public.analytics_events
      (user_id, event_name, tool, run_id, flow_id, local_app_version, local_app_build, web_build_id, platform, architecture, session_sequence, properties, occurred_at, created_at)
    values
      -- compressor run: start and terminal by run_id column; a stray row after the terminal.
      ('${ALICE}','tool_opened','compressor',null,null,'1.2.5','2105','1.2.5','macos','arm64',1,'{"tool_identifier":"compressor"}','2026-10-01T10:00:00Z','2026-10-01T10:00:00.100Z'),
      ('${ALICE}','compression_started','compressor','${RUN}',null,'1.2.5','2105','1.2.5','macos','arm64',2,'{"video_count":1,"path":"/private/video.mp4"}','2026-10-01T10:01:00Z','2026-10-01T10:01:00.300Z'),
      ('${ALICE}','compression_completed','compressor','${RUN}',null,'1.2.5','2105','1.2.5','macos','arm64',3,'{"total_input_bytes":100,"total_output_bytes":40,"outcome":"success"}','2026-10-01T10:02:00Z','2026-10-01T10:02:00.500Z'),
      ('${ALICE}','compression_failed','compressor','${RUN}',null,'1.2.5','2105','1.2.5','macos','arm64',4,'{}','2026-10-01T10:03:00Z','2026-10-01T10:03:00.100Z'),
      -- link check by flow_id column.
      ('${ALICE}','link_check_started',null,null,'${FLOW}',null,null,'1.2.5','macos',null,1,'{"link_trigger":"boot"}','2026-10-02T08:00:00Z','2026-10-02T08:00:00.100Z'),
      ('${ALICE}','link_lost',null,null,'${FLOW}',null,null,'1.2.5','macos',null,2,'{"link_transport":"stream"}','2026-10-02T08:00:30Z','2026-10-02T08:00:30.100Z'),
      -- team file attempt by attempt_id property, started only.
      ('${ALICE}','team_file_attempt_started',null,null,null,null,null,'1.2.5','windows',null,1,'{"attempt_id":"${ATTEMPT}","action":"upload","stage":"uploading"}','2026-10-03T08:00:00Z','2026-10-03T08:00:00.100Z'),
      -- team workflow by workflow_id property.
      ('${ALICE}','team_workflow_started',null,null,null,null,null,'1.2.5','macos',null,1,'{"workflow_id":"${WORKFLOW}","category":"video"}','2026-10-04T08:00:00Z','2026-10-04T08:00:00.100Z'),
      ('${ALICE}','team_workflow_completed',null,null,null,null,null,'1.2.5','macos',null,2,'{"workflow_id":"${WORKFLOW}","category":"video","outcome":"failure","retryable":true}','2026-10-04T08:01:00Z','2026-10-04T08:01:00.100Z');

    insert into public.analytics_events
      (user_id, event_name, tool, run_id, attempt_id, agent_instance_id, agent_platform, web_build_id, platform, session_sequence, properties, occurred_at, created_at)
    values
      -- a team file attempt from a v3 client: the id lives in the column, not in properties.
      ('${ALICE}','team_file_attempt_started',null,null,'${ATTEMPT_V3}',null,null,'1.2.6','macos',1,'{"action":"download","stage":"downloading"}','2026-10-05T08:00:00Z','2026-10-05T08:00:00.100Z'),
      ('${ALICE}','team_file_attempt_completed',null,null,'${ATTEMPT_V3}',null,null,'1.2.6','macos',2,'{"action":"download","outcome":"success"}','2026-10-05T08:00:04Z','2026-10-05T08:00:04.100Z'),
      -- a compressor run across an Agent restart, the browser on Windows, the Agent on macOS.
      ('${ALICE}','compression_started','compressor','${RUN_V3}',null,'${INSTANCE_A}','macos','1.2.6','windows',1,'{"video_count":1}','2026-10-06T08:00:00Z','2026-10-06T08:00:00.100Z'),
      ('${ALICE}','compression_failed','compressor','${RUN_V3}',null,'${INSTANCE_B}','macos','1.2.6','windows',2,'{"error_code":"MEDIA_TOOL_UNAVAILABLE"}','2026-10-06T08:05:00Z','2026-10-06T08:05:00.100Z');
  `);
}, 30_000);

afterAll(async () => {
  await db.close();
});

function found(data: InspectData): InspectFound {
  if (!data.found) throw new Error('expected a found attempt');
  return data;
}

describe('inspect · by run_id', () => {
  it('returns the run oldest first with stages, terminal, last proven stage and lag', async () => {
    const data = found(await getInspect(RUN));
    expect(data.matched_by).toEqual(['run_id']);
    expect(data.capability).toBe('compressor.run');
    expect(data.tool).toBe('compressor');
    expect(data.events.map(row => row.event_name)).toEqual([
      'compression_started',
      'compression_completed',
      'compression_failed'
    ]);
    expect(data.stages).toEqual({
      expected: ['open', 'ready', 'input_add', 'estimate', 'start', 'terminal'],
      observed: ['start', 'terminal'],
      missing: ['open', 'ready', 'input_add', 'estimate']
    });
    expect(data.last_proven_stage).toBe('terminal');
    // The latest terminal wins: the failed row came after the completed one.
    expect(data.terminal).toEqual({
      event: 'compression_failed',
      outcome: 'failure',
      occurred_at: '2026-10-01T10:03:00.000Z'
    });
    expect(data.first_seen_at).toBe('2026-10-01T10:01:00.000Z');
    expect(data.last_seen_at).toBe('2026-10-01T10:03:00.000Z');
    expect(data.delivery_lag_ms).toEqual({ p50: 300, p95: 480, samples: 3 });
    expect(data.agent).toMatchObject({
      local_app_versions: ['1.2.5'],
      local_app_builds: ['2105'],
      web_build_ids: ['1.2.5'],
      platforms: ['macos'],
      architectures: ['arm64'],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: []
    });
  });

  it('sanitizes properties through the client allowlist', async () => {
    const data = found(await getInspect(RUN));
    expect(data.events[0].properties).toEqual({ video_count: 1 });
    expect(JSON.stringify(data)).not.toContain('video.mp4');
  });

  it('honours as_of and reads the terminal that existed then', async () => {
    const data = found(await getInspect(RUN, '2026-10-01T10:02:30.000Z'));
    expect(data.events.map(row => row.event_name)).toEqual([
      'compression_started',
      'compression_completed'
    ]);
    expect(data.terminal?.outcome).toBe('success');
  });
});

describe('inspect · by flow_id, attempt_id, workflow_id', () => {
  it('matches the flow_id column and picks the link capability', async () => {
    const data = found(await getInspect(FLOW));
    expect(data.matched_by).toEqual(['flow_id']);
    expect(['link.check', 'link.lost']).toContain(data.capability);
    expect(data.events).toHaveLength(2);
  });

  it('matches an opaque attempt_id kept in properties and reports the missing terminal', async () => {
    const data = found(await getInspect(ATTEMPT));
    expect(data.matched_by).toEqual(['attempt_id']);
    expect(data.capability).toBe('team.file_ops');
    expect(data.stages).toEqual({
      expected: ['start', 'terminal'],
      observed: ['start'],
      missing: ['terminal']
    });
    expect(data.terminal).toBeNull();
    expect(data.last_proven_stage).toBe('start');
    expect(data.agent.platforms).toEqual(['windows']);
  });

  it('matches an attempt_id kept in the envelope v3 column and closes it with its terminal', async () => {
    const data = found(await getInspect(ATTEMPT_V3));
    expect(data.matched_by).toEqual(['attempt_id']);
    expect(data.capability).toBe('team.file_ops');
    expect(data.stages.missing).toEqual([]);
    expect(data.terminal).toMatchObject({ event: 'team_file_attempt_completed' });
    expect(data.events.map(row => row.event_name)).toEqual([
      'team_file_attempt_started',
      'team_file_attempt_completed'
    ]);
    // The envelope columns describe the attempt; they are not echoed per event.
    expect(data.events[0]).not.toHaveProperty('attempt_id');
  });

  it("names the Agent run that saw the attempt last, every run, and the Agent's platform", async () => {
    const data = found(await getInspect(RUN_V3));
    expect(data.agent).toMatchObject({
      agent_instance_id: INSTANCE_B,
      agent_instance_ids: [INSTANCE_A, INSTANCE_B],
      agent_platforms: ['macos'],
      platforms: ['windows']
    });
    expect(data.events[0]).not.toHaveProperty('agent_instance_id');
  });

  it('matches a workflow_id and reads the outcome from the terminal properties', async () => {
    const data = found(await getInspect(WORKFLOW));
    expect(data.matched_by).toEqual(['workflow_id']);
    expect(['team.process', 'team.restitch']).toContain(data.capability);
    expect(data.terminal).toMatchObject({ event: 'team_workflow_completed', outcome: 'failure' });
  });
});

describe('inspect · not found', () => {
  it('returns found:false for an unknown id and for an id with unsafe characters', async () => {
    expect(await getInspect('40000000-0000-4000-8000-000000000009')).toEqual({
      found: false,
      id: '40000000-0000-4000-8000-000000000009'
    });
    expect(await getInspect('nothing-here')).toEqual({ found: false, id: 'nothing-here' });
    expect(await getInspect("x' or 1=1")).toEqual({ found: false, id: "x' or 1=1" });
  });

  it('runs as a command with the standard envelope data and a human table', async () => {
    const result = await executeCommand(parseArgs(['inspect', RUN]));
    expect((result.data as InspectData).found).toBe(true);
    expect(result.human).toContain('compressor.run');
    expect(result.human).toContain('compression_failed (failure)');
    expect(formatInspect({ found: false, id: 'zzz' })).toContain('No event carries this id');
    await expect(executeCommand(parseArgs(['inspect']))).rejects.toThrow(/Usage: inspect/);
  });
});
