// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, renderHook, act, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchHistory } from '../apps/web/src/team/launches/LaunchHistory';
import { useLaunchDraft } from '../apps/web/src/team/launches/useLaunchDraft';
import { launchConfig, launchSources } from './fixtures/launches';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
afterEach(cleanup);
function props() {
  return {
    rows: [
      {
        id: 'old',
        revisionNo: 1,
        createdAt: '2026-10-13T10:00:00Z',
        kind: 'generated' as const,
        state: 'succeeded' as const
      }
    ],
    editable: true,
    disabled: false,
    confirming: true,
    decisionBusy: false,
    savePending: false,
    onView: vi.fn(),
    onRestore: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn()
  };
}
it('offers explicit save, discard and cancel without running a mutation on render', () => {
  const p = props();
  render(<LaunchHistory {...p} />);
  expect(p.onSave).not.toHaveBeenCalled();
  expect(p.onRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save and restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard and restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(p.onSave).toHaveBeenCalledOnce();
  expect(p.onDiscard).toHaveBeenCalledOnce();
  expect(p.onCancel).toHaveBeenCalledOnce();
});
it('keeps the original save replayable while preventing discard of an uncertain save', () => {
  const p = props();
  render(<LaunchHistory {...p} savePending />);
  fireEvent.click(screen.getByRole('button', { name: 'Discard and restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save and restore' }));
  expect(p.onDiscard).not.toHaveBeenCalled();
  expect(p.onCancel).not.toHaveBeenCalled();
  expect(p.onSave).toHaveBeenCalledOnce();
});
it('blocks restore decisions after edit access is revoked or generation locks input', () => {
  const p = props();
  const view = render(<LaunchHistory {...p} editable={false} />);
  expect(screen.getByRole('button', { name: 'Save and restore' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Discard and restore' })).toHaveProperty(
    'disabled',
    true
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(p.onCancel).toHaveBeenCalledOnce();
  expect(p.onSave).not.toHaveBeenCalled();
  expect(p.onDiscard).not.toHaveBeenCalled();
  view.rerender(<LaunchHistory {...p} decisionBusy />);
  expect(screen.getByRole('button', { name: 'Save and restore' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Discard and restore' })).toHaveProperty(
    'disabled',
    true
  );
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
});
it('lets a viewer inspect a ready historical result without offering restore', () => {
  const p = props();
  render(<LaunchHistory {...p} editable={false} confirming={false} />);
  expect(screen.queryByRole('button', { name: 'Restore configuration' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /#1/u }));
  expect(p.onView).toHaveBeenCalledWith('old');
  expect(p.onRestore).not.toHaveBeenCalled();
});
it('labels failed attempts and only allows restoring their configuration, with no result presented as ready', () => {
  const p = props();
  render(<LaunchHistory {...p} confirming={false} rows={[{ ...p.rows[0], state: 'failed' }]} />);
  expect(screen.getByText('Generation needs attention')).toBeTruthy();
  const buttons = screen.getAllByRole('button');
  expect(buttons[0]).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Restore configuration' }));
  expect(p.onRestore).toHaveBeenCalledWith('old');
  expect(p.onView).not.toHaveBeenCalled();
});
it('keeps the saved optimistic version when a historical configuration is restored in the same update', () => {
  const config = launchConfig();
  const current = {
    id: 'launch',
    version: '3',
    draft: config,
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  } satisfies LaunchDetail;
  const hook = renderHook(() => useLaunchDraft(current));
  act(() => {
    hook.result.current.acknowledge({ ...config, age: 50 }, null, '5');
    hook.result.current.setConfig({ ...config, age: 40 });
  });
  expect(hook.result.current.baseVersion).toBe('5');
  expect(hook.result.current.config.age).toBe(40);
  expect(hook.result.current.dirty).toBe(true);
});
it('does not flag identical server JSONB key order as unsaved edits after an acknowledged save', () => {
  const config = launchConfig();
  const current = {
    id: 'launch',
    version: '3',
    draft: config,
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  } satisfies LaunchDetail;
  const hook = renderHook(({ detail }) => useLaunchDraft(detail), {
    initialProps: { detail: current }
  });
  const reordered = Object.fromEntries(Object.entries(config).reverse()) as typeof config;
  act(() => {
    hook.result.current.acknowledge(reordered, null, '4');
  });
  hook.rerender({ detail: { ...current, version: '4', draft: reordered } });
  expect(hook.result.current.dirty).toBe(false);
  expect(hook.result.current.baseVersion).toBe('4');
  act(() => {
    hook.result.current.setConfig(old => ({
      ...old,
      subConfig: { ...config.subConfig, sub2: ['creative', 'social', 'adAccountSuffix'] }
    }));
  });
  expect(hook.result.current.dirty).toBe(true);
});

it('treats initial source resolution as hydration, while user edits remain dirty', () => {
  const config = launchConfig();
  const sourceSnapshot = {
    ...launchSources,
    schemaVersion: 1 as const,
    agentRowId: config.agentRowId,
    offerId: config.offerId,
    buyerId: config.buyerId,
    materialId: config.materialId,
    catalogSettingsVersion: null
  };
  const current = {
    id: 'launch',
    version: '3',
    draft: config,
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  } satisfies LaunchDetail;
  const hook = renderHook(() => useLaunchDraft(current));
  act(() => hook.result.current.resolveSources(sourceSnapshot));
  expect(hook.result.current.dirty).toBe(false);
  act(() => hook.result.current.resolveSources({ ...sourceSnapshot, buyer: 'updated buyer' }));
  expect(hook.result.current.dirty).toBe(true);
  act(() => {
    hook.result.current.setConfig(old => ({ ...old, age: 50 }));
    hook.result.current.setSources(null);
  });
  act(() => hook.result.current.resolveSources(sourceSnapshot));
  expect(hook.result.current.dirty).toBe(true);
});

it('stages an old dated configuration without restoring its source or changing the active result', () => {
  const currentConfig = launchConfig({ launchDate: '2026-10-20', maxBudget: 40 });
  const historicalConfig = launchConfig({ launchDate: '2025-02-03', maxBudget: 90 });
  const currentSource = {
    ...launchSources,
    schemaVersion: 1 as const,
    agentRowId: currentConfig.agentRowId,
    offerId: currentConfig.offerId,
    buyerId: currentConfig.buyerId,
    materialId: currentConfig.materialId,
    catalogSettingsVersion: null
  };
  const current = {
    id: 'launch',
    version: '7',
    draft: currentConfig,
    expectedSourceSnapshot: currentSource,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  } satisfies LaunchDetail;
  const hook = renderHook(() => useLaunchDraft(current));
  expect(hook.result.current.sources).toEqual(currentSource);
  act(() => {
    hook.result.current.setConfig(historicalConfig);
    hook.result.current.setSources(null);
  });
  expect(hook.result.current.config).toMatchObject({
    launchDate: '2025-02-03',
    maxBudget: 90
  });
  expect(hook.result.current.sources).toBeNull();
  expect(hook.result.current.baseVersion).toBe('7');
  expect(hook.result.current.dirty).toBe(true);
  expect(current.draft).toEqual(currentConfig);
  expect(current.activeRevision).toBeNull();
});
