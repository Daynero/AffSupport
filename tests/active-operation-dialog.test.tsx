// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TeamOperationSnapshot } from '../apps/web/src/api/team';
import { ActiveOperation } from '../apps/web/src/team/processing/MaterialProcessFlow';

const state = vi.hoisted(() => ({
  operation: null as TeamOperationSnapshot | null,
  localProgress: null as { stage: string; progress: number } | null,
  error: null as string | null,
  cancel: vi.fn(async () => {})
}));
vi.mock('../apps/web/src/team/processing/useTeamOperation', () => ({
  useTeamOperation: () => state
}));
vi.mock('../apps/web/src/analytics/service', async importOriginal => {
  const original = await importOriginal<typeof import('../apps/web/src/analytics/service')>();
  return { ...original, completeTeamWorkflow: vi.fn() };
});
const workflow = {
  workflowId: 'flow',
  category: 'video' as const,
  cacheState: 'unknown' as const,
  attemptNumber: 1,
  startedAt: 0,
  completed: false
};
function operation(status: 'running' | 'canceled'): TeamOperationSnapshot {
  return {
    id: 'operation',
    teamId: 'team',
    kind: 'process',
    state: status,
    stage: status === 'running' ? 'processing' : status,
    progress: 0,
    sourceMaterialId: 'source',
    resultMaterialId: null,
    errorCode: null,
    retryable: false,
    createdAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:00:01Z'
  };
}
function show() {
  const close = vi.fn(),
    intent = vi.fn(),
    progress = vi.fn();
  render(
    <ActiveOperation
      teamId="team"
      operationId="operation"
      workflow={workflow}
      agentEnabled
      onClose={close}
      onRetry={vi.fn()}
      onCancelIntent={intent}
      onProgress={progress}
    />
  );
  return { close, intent, progress };
}
beforeEach(() => {
  localStorage.setItem('language', 'en');
  state.operation = null;
  state.localProgress = null;
  state.error = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

it('keeps loading inside the visible accessible dialog instead of below the explorer table', () => {
  show();
  const dialog = screen.getByRole('dialog', { name: 'Operation progress' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
});
it('keeps an active operation visible, exposes cancel and does not dismiss on Escape', async () => {
  state.operation = operation('running');
  state.localProgress = { stage: 'processing', progress: 20 };
  const f = show();
  const dialog = screen.getByRole('dialog', { name: 'Operation progress' });
  await userEvent.keyboard('{Escape}');
  expect(f.close).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel operation' }));
  expect(f.intent).toHaveBeenCalledOnce();
  expect(state.cancel).toHaveBeenCalledOnce();
});
it('retains measured terminal progress for the dialog and its observing task card, then allows Close', async () => {
  state.operation = operation('canceled');
  state.localProgress = { stage: 'canceled', progress: 20 };
  const f = show();
  const dialog = screen.getByRole('dialog', { name: 'Operation progress' });
  expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20');
  expect(f.progress).toHaveBeenCalledWith({ progress: 20, state: 'canceled' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(f.close).toHaveBeenCalledOnce();
});
it('allows leaving when the initial operation status cannot be read', async () => {
  state.error = 'DRIVE_UNAVAILABLE';
  const f = show();
  const dialog = screen.getByRole('dialog', { name: 'Operation progress' });
  expect(within(dialog).getByRole('alert')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(f.close).toHaveBeenCalledOnce();
});

it('lets the person dismiss a status-read failure without implicitly canceling known running work', async () => {
  state.operation = operation('running');
  state.error = 'DRIVE_UNAVAILABLE';
  const f = show();
  const dialog = screen.getByRole('dialog', { name: 'Operation progress' });
  expect(within(dialog).getByRole('alert')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(f.close).toHaveBeenCalledOnce();
  expect(state.cancel).not.toHaveBeenCalled();
});
