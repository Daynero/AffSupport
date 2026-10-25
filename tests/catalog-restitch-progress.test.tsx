// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TeamOperationSnapshot } from '../apps/web/src/api/team';
import { useAgentEventStream } from '../apps/web/src/api/useAgentEventStream';
import { CatalogRestitchProgress } from '../apps/web/src/team/product-catalog/CatalogRestitchProgress';

vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: () => null }));
vi.mock('../apps/web/src/AgentContext', () => ({ useOptionalAgent: () => null }));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useOptionalTeam: () => null }));
vi.mock('../apps/web/src/analytics/errors', () => ({
  teamOperationErrorStage: vi.fn(),
  trackToolError: vi.fn()
}));

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
function snapshot(id: string, patch: Partial<TeamOperationSnapshot> = {}): TeamOperationSnapshot {
  return {
    id,
    teamId: 'team',
    kind: 'process',
    state: 'running',
    stage: 'processing',
    progress: 42,
    sourceMaterialId: 'video',
    resultMaterialId: null,
    errorCode: null,
    retryable: false,
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:01Z',
    ...patch
  };
}
const bar = () => screen.getByRole('progressbar', { name: 'Video re-stitching progress' });
const stream = () => vi.mocked(useAgentEventStream).mock.calls.at(-1)![0];

it('shows immediate indeterminate feedback before a child exists, without reporting a percentage', () => {
  const getOperation = vi.fn();
  render(<CatalogRestitchProgress teamId="team" operationId={null} client={{ getOperation }} />);
  expect(bar().getAttribute('aria-valuenow')).toBeNull();
  expect(screen.getByText('Re-stitching the video before creating the catalog…')).toBeTruthy();
  expect(getOperation).not.toHaveBeenCalled();
  expect(stream().url).toBeNull();
});

it('shows confirmed cloud and local progress for this child, then returns to unknown on disconnect', async () => {
  const getOperation = vi.fn().mockResolvedValue(snapshot('active'));
  render(<CatalogRestitchProgress teamId="team" operationId="active" client={{ getOperation }} />);
  await act(async () => undefined);
  expect(bar().getAttribute('aria-valuenow')).toBe('42');
  const update = (operationId: string, progress: number) => ({
    type: 'team:operations',
    operations: [
      {
        operationId,
        state: 'running',
        stage: 'uploading',
        progress,
        errorCode: null,
        updatedAt: '2026-10-25T00:00:02Z'
      }
    ]
  });
  act(() => stream().onMessage(update('unrelated', 99)));
  expect(bar().getAttribute('aria-valuenow')).toBe('42');
  act(() => stream().onMessage(update('active', 67)));
  expect(bar().getAttribute('aria-valuenow')).toBe('67');
  act(() => stream().onDisconnect?.('network'));
  expect(bar().getAttribute('aria-valuenow')).toBeNull();
  expect(screen.queryByText('67%')).toBeNull();
  await act(async () => {
    stream().onOpen?.();
  });
  expect(bar().getAttribute('aria-valuenow')).toBe('42');
});

it('does not reuse another attempt’s late cloud result after a retry', async () => {
  const pending: Array<(value: TeamOperationSnapshot) => void> = [];
  const getOperation = vi.fn((_team: string, id: string) =>
    id === 'old'
      ? new Promise<TeamOperationSnapshot>(resolve => pending.push(resolve))
      : Promise.resolve(snapshot(id, { progress: 17 }))
  );
  const client = { getOperation };
  const view = render(<CatalogRestitchProgress teamId="team" operationId="old" client={client} />);
  view.rerender(<CatalogRestitchProgress teamId="team" operationId="new" client={client} />);
  await act(async () => undefined);
  expect(bar().getAttribute('aria-valuenow')).toBe('17');
  await act(async () => {
    pending.forEach(resolve => resolve(snapshot('old', { progress: 99 })));
  });
  expect(bar().getAttribute('aria-valuenow')).toBe('17');
});

it('keeps an unreadable operation indeterminate without displaying provider details', async () => {
  const getOperation = vi.fn().mockRejectedValue(new Error('private provider detail'));
  render(
    <CatalogRestitchProgress teamId="team" operationId="unreadable" client={{ getOperation }} />
  );
  await act(async () => undefined);
  expect(bar().getAttribute('aria-valuenow')).toBeNull();
  expect(document.body.textContent).not.toContain('private provider detail');
});

it.each(['failed', 'canceled'] as const)(
  'stops the active indicator after a confirmed %s result',
  async state => {
    const getOperation = vi.fn().mockResolvedValue(
      snapshot(`terminal-${state}`, {
        state,
        errorCode: state === 'failed' ? 'PROCESS_FAILED' : null
      })
    );
    render(
      <CatalogRestitchProgress
        teamId="team"
        operationId={`terminal-${state}`}
        client={{ getOperation }}
      />
    );
    await act(async () => undefined);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(
      screen.getByText(state === 'failed' ? 'Operation failed' : 'Operation canceled')
    ).toBeTruthy();
  }
);
