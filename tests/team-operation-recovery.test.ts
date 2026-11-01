import { expect, it } from 'vitest';
import type { DiagnosticRecord } from '../packages/shared/src/types';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events';

const terminal = (operationId: string, outcome: string, seq = 1): DiagnosticRecord => ({
  seq,
  at: 1000 * seq,
  category: 'team',
  code: 'process_terminal',
  props: { operationId, outcome, errorCode: 'UNSUPPORTED_MEDIA' }
});

it('restores a proven failure after restart with its original time and safe reason', () => {
  const events = new TeamOperationEvents();
  events.restoreFailures([terminal('child', 'failed')]);
  expect(events.snapshot().operations).toEqual([
    {
      operationId: 'child',
      state: 'failed',
      stage: 'failed',
      progress: 0,
      errorCode: 'UNSUPPORTED_MEDIA',
      updatedAt: new Date(1000).toISOString()
    }
  ]);
});

it('never infers failure from silence, a running record or a later success', () => {
  const events = new TeamOperationEvents();
  events.restoreFailures([
    terminal('child', 'failed'),
    terminal('child', 'succeeded', 2),
    { ...terminal('running', 'failed'), code: 'process_started' }
  ]);
  expect(events.snapshot().operations).toEqual([]);
});

it('keeps current live evidence and rejects unsafe identifiers and error text', () => {
  const events = new TeamOperationEvents();
  events.update('live', { state: 'running', stage: 'processing', progress: 25 });
  events.restoreFailures([
    terminal('live', 'failed'),
    terminal('/private/source', 'failed'),
    {
      ...terminal('safe', 'failed'),
      props: { operationId: 'safe', outcome: 'failed', errorCode: '/secret/path' }
    }
  ]);
  expect(
    events.snapshot().operations.map(row => [row.operationId, row.state, row.errorCode])
  ).toEqual([
    ['live', 'running', null],
    ['safe', 'failed', 'PROCESS_FAILED']
  ]);
});
