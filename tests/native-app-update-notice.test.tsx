// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import { fakeAgentValue } from './support/fake-agent';
import { nativeSnapshot } from './support/native-app-updates';
import ReleaseUpdateNotice from '../apps/web/src/components/ReleaseUpdateNotice';
const mock = vi.hoisted(() => ({ hook: vi.fn(), act: vi.fn() }));
vi.mock('../apps/web/src/updates/useNativeAppUpdate', () => ({ useNativeAppUpdate: mock.hook }));
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  mock.act.mockReset();
  mock.hook.mockReturnValue({
    state: nativeSnapshot(),
    pending: false,
    error: false,
    act: mock.act,
    refresh: vi.fn()
  });
});
afterEach(cleanup);
const show = () =>
  render(
    <AgentContextOverride
      value={fakeAgentValue({ capabilities: ['event-stream', 'native-app-updates-v1'] })}
    >
      <ReleaseUpdateNotice />
    </AgentContextOverride>
  );
describe('native app update consent', () => {
  it('uses one explicit native acceptance rather than a download-only promise', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Update when tasks finish' }));
    expect(mock.act).toHaveBeenCalledWith('accept');
    expect(screen.getByText(/macOS may ask/)).toBeTruthy();
  });
  it('shows preserved work and disables replacement actions after commitment', () => {
    const state = nativeSnapshot();
    state.stage = 'install_committed';
    state.availableActions = [];
    mock.hook.mockReturnValue({
      state,
      pending: false,
      error: false,
      act: mock.act,
      refresh: vi.fn()
    });
    show();
    expect(screen.getByText(/will reopen automatically/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update when tasks finish' })).toBe(null);
    expect(screen.queryByRole('button', { name: 'Cancel update' })).toBe(null);
  });
  it('does not call a restarted target user-visible success', () => {
    const state = nativeSnapshot();
    state.stage = 'target_started';
    state.availableActions = [];
    mock.hook.mockReturnValue({
      state,
      pending: false,
      error: false,
      act: mock.act,
      refresh: vi.fn()
    });
    show();
    expect(screen.queryByText('The updated app and its local tools are ready.')).toBe(null);
  });
});
