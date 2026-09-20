// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { AgentTasksPeek } from '../apps/web/src/team/accounts/AgentTasksPeek';

/**
 * An agent's tasks on its "N tasks" (024): resting on the count shows them, and a × takes the
 * agent off one task without leaving the Accounts tab.
 */

const TEAM = '24000000-0000-4000-8000-000000000001';
const AGENT = '24000000-0000-4000-8000-000000000002';

function task(id: string, title: string): TeamTaskSummary {
  return { id, title, status: 'in_progress' } as TeamTaskSummary;
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('an agent’s tasks on its count', () => {
  it('shows the tasks on focus, and takes the agent off one with its ×', async () => {
    const client = {
      listTasks: vi.fn().mockResolvedValue([task('t1', 'Pro Caps'), task('t2', 'Leggings')]),
      detachTaskAgent: vi.fn().mockResolvedValue([])
    };
    render(
      <ToastProvider>
        <AgentTasksPeek
          teamId={TEAM}
          agentRowId={AGENT}
          agentLabel="v31-434"
          canEdit
          client={client as never}
          trigger={<a href="#tasks">2 tasks</a>}
        />
      </ToastProvider>
    );
    fireEvent.focus(screen.getByRole('link', { name: '2 tasks' }));
    expect(await screen.findByText('Pro Caps')).toBeTruthy();
    expect(client.listTasks).toHaveBeenCalledWith(expect.objectContaining({ agentRowId: AGENT }));

    fireEvent.click(screen.getByRole('button', { name: 'Take v31-434 off “Pro Caps”' }));
    await waitFor(() =>
      expect(client.detachTaskAgent).toHaveBeenCalledWith({
        teamId: TEAM,
        taskId: 't1',
        agentRowId: AGENT
      })
    );
    expect(screen.queryByText('Pro Caps')).toBeNull();
    expect(screen.getByText('Leggings')).toBeTruthy();
  });
});
