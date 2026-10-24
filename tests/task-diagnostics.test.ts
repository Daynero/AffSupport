import { afterAll, beforeAll, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc: seam.rpc }),
  getSupabaseClient: () => null,
  withFreshSession: async (fn: () => unknown) => fn()
}));
import { teamApi } from '../apps/web/src/api/team';
import { analytics } from '../apps/web/src/analytics/service';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { taskAttempt, taskFlowFor } from '../apps/web/src/team/tasks/diagnostics';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAudit, getInspect } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
import { getInvestigation } from '../scripts/analytics/investigate';
const ID = '60000000-0000-4000-8000-000000000091';
const TEAM = '60000000-0000-4000-8000-000000000092';
const row = {
  id: ID,
  team_id: TEAM,
  created_by: ID,
  title: 'secret-title',
  note: 'secret-note',
  assignee_id: null,
  assignee_label_snapshot: null,
  status: 'todo',
  progress_max: 100,
  progress_value: 0,
  progress_manually_set: false,
  attachment_count: 0,
  agents: [],
  labels: [],
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  completed_at: null
};
let db: AnalyticsTestDb;
const events: Array<{ event: string; props: Record<string, unknown> }> = [];
const pending: Promise<unknown>[] = [];
const rawProperties: string[] = [];
const attempts: Array<ReturnType<typeof taskAttempt>> = [];
beforeAll(async () => {
  db = await createAnalyticsDb();
  vi.spyOn(analytics, 'track').mockImplementation((event, properties) => {
    rawProperties.push(JSON.stringify(properties));
    const props = sanitizeAnalyticsProperties(properties ?? {}, event);
    events.push({ event, props });
    pending.push(
      db.db.query(
        `insert into public.analytics_events(user_id,event_name,attempt_id,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$5::jsonb,$6,$6)`,
        [ID, event, props.attempt_id, props.flow_id, JSON.stringify(props), '2026-10-01T10:00:00Z']
      )
    );
  });
  seam.rpc.mockResolvedValue({ data: row, error: null });
  const created = await teamApi.createTask({ teamId: TEAM, title: row.title, note: row.note });
  const initialVisible = taskAttempt('task_editor_refresh', taskFlowFor(created));
  attempts.push(initialVisible);
  initialVisible.accepted();
  initialVisible.finish('success');
  seam.rpc.mockResolvedValue({ data: { task: row, attachments: [] }, error: null });
  const read = await teamApi.getTask({ teamId: TEAM, taskId: ID });
  expect(taskFlowFor(read.task)).toBe(ID);
  seam.rpc.mockResolvedValue({ data: [row], error: null });
  await teamApi.listTasks({ teamId: TEAM });
  seam.rpc.mockResolvedValue({ data: { ...row, status: 'done' }, error: null });
  await teamApi.updateTask(TEAM, ID, { status: 'done' });
  seam.rpc.mockResolvedValue({
    data: null,
    error: { code: '42501', message: 'PERMISSION_DENIED' }
  });
  await expect(teamApi.updateTask(TEAM, ID, { status: 'todo' })).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  seam.rpc.mockResolvedValue({ data: null, error: null });
  await expect(teamApi.getTask({ teamId: TEAM, taskId: ID })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
  seam.rpc.mockResolvedValue({ data: {}, error: null });
  await expect(teamApi.listTasks({ teamId: TEAM })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
  const missing = taskAttempt('task_editor_refresh', ID);
  attempts.push(missing);
  missing.accepted();
  const hiddenClose = taskAttempt('task_editor_refresh', ID);
  attempts.push(hiddenClose);
  hiddenClose.accepted();
  hiddenClose.finish('cancelled');
  hiddenClose.finish('success');
  const preserved = taskAttempt('task_editor_preserve_draft', ID);
  attempts.push(preserved);
  preserved.accepted();
  preserved.finish('success');
  const invalidCorrelation = taskAttempt('task_read', 'secret-provider/private-file');
  invalidCorrelation.finish('failure', new Error('secret-provider'));
  const unknown = taskAttempt('task_read', ID);
  attempts.push(unknown);
  unknown.finish('failure', new Error('secret-provider private-file'));
  await Promise.all(pending);
  vi.restoreAllMocks();
}, 30_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await db?.close();
});
it('carries real API signals through sanitizer, storage and read-only diagnosis without task content', async () => {
  expect(rawProperties.length).toBeGreaterThan(0);
  expect(rawProperties.join(' ')).not.toMatch(
    /secret-title|secret-note|secret-provider|private-file/
  );
  for (const step of ['task_create', 'task_list', 'task_read', 'task_update']) {
    const start = events.find(e => e.event === 'operation_started' && e.props.flow_step === step)!;
    const found = await getInspect(String(start.props.attempt_id));
    if (!found.found) throw Error('Expected actual API attempt');
    expect(found.capability).toBe('team.tasks.' + step.slice(5));
    expect(found.terminal?.event).toBe('operation_completed');
  }
  const create = events.find(
    e => e.event === 'operation_started' && e.props.flow_step === 'task_create'
  )!;
  expect(attempts[0].properties.flow_id).toBe(create.props.flow_id);
});
it('keeps RPC acceptance separate from a visible editor and from preservation of local edits', async () => {
  const visible = await getInspect(attempts[0].properties.attempt_id);
  const preserved = await getInspect(attempts[3].properties.attempt_id);
  expect(visible.found && visible.capability).toBe('team.tasks.editor_refresh');
  expect(preserved.found && preserved.capability).toBe('team.tasks.editor_preserve_draft');
  const missing = await getInspect(attempts[1].properties.attempt_id);
  expect(missing.found && missing.terminal).toBeNull();
  const cancelled = await getInspect(attempts[2].properties.attempt_id);
  expect(cancelled.found && cancelled.terminal?.event).toBe('operation_cancelled');
  expect(
    events.filter(
      e =>
        e.props.attempt_id === attempts[2].properties.attempt_id &&
        e.event === 'operation_completed'
    )
  ).toHaveLength(0);
  const audit = await getAudit(resolvePeriod('all', undefined, '2026-10-02T00:00:00Z'));
  expect(audit.capabilities.find(c => c.id === 'team.tasks.editor_refresh')).toMatchObject({
    samples: 3,
    orphan_starts: 1,
    correlated_pairs: 2
  });
});
it('preserves closed refusals, malformed replies and unknown failures with source locations', async () => {
  for (const code of ['PERMISSION_DENIED', 'INVALID_RESPONSE', 'unknown'])
    expect(events.some(e => e.event === 'error_occurred' && e.props.error_code === code)).toBe(
      true
    );
  expect(lookupCodeLocations('tasks:task_update:PERMISSION_DENIED')?.files).toContain(
    'apps/web/src/team/tasks/TaskEditor.tsx'
  );
});

it('drops late task signals after identity changes rather than attributing them to the next user', () => {
  let userId: string | null = ID;
  const context = vi
    .spyOn(analytics, 'journalContext')
    .mockImplementation(() => ({ enabled: true, userId, installationId: ID, instanceId: null }));
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  try {
    const pending = taskAttempt('task_read', ID);
    expect(track).toHaveBeenCalledOnce();
    userId = TEAM;
    pending.accepted();
    pending.finish('success');
    expect(track).toHaveBeenCalledOnce();
  } finally {
    track.mockRestore();
    context.mockRestore();
  }
});

it('keeps the precise failure fingerprint when a later terminal carries only the closed code', async () => {
  const failure = events.find(
    e => e.event === 'error_occurred' && e.props.error_code === 'PERMISSION_DENIED'
  )!;
  const result = await getInvestigation(
    String(failure.props.flow_id),
    resolvePeriod('all', undefined, '2026-10-02T00:00:00Z')
  );
  const operation = result.operations.find(op => op.id === failure.props.attempt_id);
  expect(operation).toMatchObject({
    error_code: 'PERMISSION_DENIED',
    fingerprint: 'tasks:task_update:PERMISSION_DENIED'
  });
  expect(
    result.findings.some(f =>
      f.code_locations.some(location =>
        location.files.includes('apps/web/src/team/tasks/TaskEditor.tsx')
      )
    )
  ).toBe(true);
});

it('resolves opaque UUID attempt identifiers emitted by the task producer', async () => {
  const failure = events.find(
    e => e.event === 'error_occurred' && e.props.error_code === 'PERMISSION_DENIED'
  )!;
  const result = await getInvestigation(
    String(failure.props.attempt_id),
    resolvePeriod('all', undefined, '2026-10-02T00:00:00Z')
  );
  expect(result.subject.kind).toBe('attempt');
  expect(result.operations.some(op => op.id === failure.props.attempt_id)).toBe(true);
});
