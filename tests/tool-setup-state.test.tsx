// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import { ToolSetupState } from '../apps/web/src/components/ToolSetupState';
import { toolByPath } from '../apps/web/src/lib/tool-registry';
import { emptyQueueState } from './web-auth-helpers';
import { fakeAgentValue } from './support/fake-agent';

/**
 * 070, T039 / FR-029: a tool opened with no Soty on this computer is not an
 * empty page. The setup dialog still opens first; closing it leaves the tool's
 * own page saying what it needs, with the way to get it.
 */

function agentValue(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  return fakeAgentValue({
    connection: 'not_installed_or_not_running',
    state: emptyQueueState,
    connectedOnce: false,
    agentVersion: null,
    toolAvailable: () => false,
    toolAvailability: () => 'disconnected',
    ...overrides
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'uk');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a tool without the local app', () => {
  it('keeps the person on the tool page with a download and a reconnect once the dialog is closed', async () => {
    const compressor = toolByPath('/compressor')!;
    render(
      <AgentContextOverride value={agentValue()}>
        <ToolSetupState tool={compressor} connection="not_installed_or_not_running" />
      </AgentContextOverride>
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(screen.getByRole('heading', { name: 'Потрібна програма Soty' })).toBeTruthy();
    expect(screen.getByText(/Відеокомпресор працює в програмі Soty/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Перепідключити' })).toBeTruthy();

    // The download is the dialog's choice of platform, reopened from the page.
    await userEvent.click(screen.getByRole('button', { name: 'Завантажити Soty' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('asks for an update, not an install, when the app is too old for the tool', async () => {
    const compressor = toolByPath('/compressor')!;
    render(
      <AgentContextOverride value={agentValue({ connection: 'agent_update_required' })}>
        <ToolSetupState tool={compressor} connection="agent_update_required" />
      </AgentContextOverride>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }));
    expect(screen.getByRole('heading', { name: 'Потрібно оновити Soty' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Завантажити оновлення' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Перепідключити' })).toBeNull();
  });
});
