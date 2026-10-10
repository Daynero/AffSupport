import { describe, expect, it } from 'vitest';
import { panelState, watchSnapshot } from '../scripts/release-panel-watch.mjs';
import { parseSnapshot } from '../apps/web/src/release-panel/client';

const runId = '3f0c2c1e-6a5b-4d2e-9c1a-0b7d2e4f6a81';
const plan = [
  { id: 'preflight', weight: 10, confidence: 'measured' },
  { id: 'live_verify', weight: 30, confidence: 'measured' }
];
const event = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload });

describe('watching a canonical runner run', () => {
  it('turns a failed step with nothing after it into a blocker for the owner', () => {
    const events = [
      event('step_started', { stepId: 'preflight' }),
      event('step_failed', { stepId: 'preflight', error: { code: 'GATE_FAILED', subject: 'lint' } })
    ];
    // Nobody on it yet: what failed, in words, and who will act — never a command for a person.
    expect(panelState({ state: 'running' }, events)).toMatchObject({
      state: 'needs_owner',
      blocker: { code: '«Передумови» не пройшов', detail: 'lint' }
    });
    // The agent says it is on it: the panel shows that work instead of a blocker.
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    expect(
      panelState(
        { state: 'blocked' },
        events,
        { message: 'Агент виправляє форматування', updatedAt: '2026-10-10T11:50:00.000Z' },
        now
      )
    ).toEqual({ state: 'repairing', blocker: null, reason: 'Агент виправляє форматування' });
    // An agent's word goes stale; then the run is waiting again.
    expect(
      panelState(
        { state: 'blocked' },
        events,
        { message: 'old', updatedAt: '2026-10-10T10:00:00.000Z' },
        now
      ).state
    ).toBe('needs_owner');
    // A retry that has started again is running, not blocked.
    expect(
      panelState({ state: 'running' }, [...events, event('step_started', { stepId: 'preflight' })])
    ).toEqual({ state: 'running', blocker: null, reason: null });
    expect(panelState({ state: 'waiting_resource' }, [])).toMatchObject({ state: 'waiting' });
    expect(panelState({ state: 'completed' }, [])).toMatchObject({ state: 'completed' });
  });

  it('names a failed GitHub run by its link, not by the command that watched it', () => {
    const { blocker } = panelState({ state: 'running' }, [
      event('step_started', { stepId: 'windows_smoke' }),
      event('step_failed', {
        stepId: 'windows_smoke',
        error: {
          code: 'GATE_FAILED',
          subject:
            '/opt/node scripts/watch-github-run.mjs 1 — 2026-10-10T16:28:24Z completed — failure\nhttps://github.com/o/r/actions/runs/1'
        }
      })
    ]);
    expect(blocker).toMatchObject({
      code: '«Windows: перевірка» не пройшов',
      detail: 'Збірка в GitHub Actions не пройшла: https://github.com/o/r/actions/runs/1'
    });
  });

  it('serves a snapshot the panel accepts, read-only, with no stale wait on a finished run', () => {
    const snapshot = watchSnapshot(runId, plan, {
      run: {
        state: 'completed',
        version: '1.2.6',
        targetId: 'production',
        generation: 1,
        updatedAt: '2026-10-10T12:00:00.000Z',
        waitReason: 'RESOURCE_WAIT',
        nextCheckAt: '2026-10-10T11:00:00.000Z',
        currentStep: null
      },
      events: [
        event('step_completed', { stepId: 'preflight' }),
        event('step_completed', { stepId: 'live_verify' }),
        event('run_completed')
      ],
      heartbeat: null,
      windowsUrl: null
    });
    expect(parseSnapshot(snapshot)).toMatchObject({
      readOnly: true,
      state: 'completed',
      waiting: null,
      nextCheckAt: null,
      progress: { percent: 100, final: true }
    });
    // An empty journal is still revision one.
    expect(
      parseSnapshot(
        watchSnapshot(runId, plan, {
          run: { state: 'running', updatedAt: '2026-10-10T12:00:00.000Z' },
          events: [],
          heartbeat: null,
          windowsUrl: null
        })
      ).revision
    ).toBe(1);
  });
});
