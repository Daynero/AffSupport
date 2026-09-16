// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { AddToTaskDialog, type AddToTaskClient } from '../apps/web/src/team/tasks/AddToTask';

/**
 * T161 — the lead hands work over in one motion (024, US11).
 *
 * Putting a file in Files onto a task that already existed was not possible
 * from Files at all. Pinned here: typing narrows, Enter adds the selection, a
 * file already there is information rather than failure, and nothing moves
 * the address — the toast is the way to the task.
 */

const TEAM_ID = '26000000-0000-4000-8000-000000000010';

function task(id: string, title: string, updatedAt: string): TeamTaskSummary {
  return { id, title, status: 'todo', updatedAt } as TeamTaskSummary;
}

function client(over: Partial<AddToTaskClient> = {}): AddToTaskClient {
  return {
    listTasks: vi.fn(async () => [
      task('old', 'Catalog Pro Caps', '2026-09-01T10:00:00.000Z'),
      task('new', 'Transcribe TR 05/09', '2026-09-15T10:00:00.000Z'),
      task('mid', 'Catalog Leggings', '2026-09-10T10:00:00.000Z')
    ]),
    attachTaskMaterials: vi.fn(async ({ materialIds }) => ({
      attached: materialIds,
      alreadyAttached: [],
      rejected: []
    })),
    ...over
  };
}

function open(api: AddToTaskClient, onClose = vi.fn()) {
  render(
    <ToastProvider>
      <AddToTaskDialog
        teamId={TEAM_ID}
        client={api}
        materials={[
          { id: 'm1', name: 'a.mp4' },
          { id: 'm2', name: 'b.mp4' }
        ]}
        onClose={onClose}
      />
    </ToastProvider>
  );
  return { onClose };
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
  window.history.replaceState(null, '', '/team/space/explorer?folder=f1');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('add to a task', () => {
  it('lists the most recent first, narrows as you type, and adds on Enter', async () => {
    const user = userEvent.setup();
    const api = client();
    const { onClose } = open(api);

    const options = await screen.findAllByRole('option');
    // Within the server's page limit, or the list never arrives.
    expect(api.listTasks).toHaveBeenCalledWith({ teamId: TEAM_ID, pageSize: 100 });
    expect(options.map(option => option.textContent)).toEqual([
      expect.stringContaining('Transcribe TR 05/09'),
      expect.stringContaining('Catalog Leggings'),
      expect.stringContaining('Catalog Pro Caps')
    ]);

    await user.type(screen.getByRole('combobox', { name: 'Find a task by name' }), 'catalog');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() =>
      expect(api.attachTaskMaterials).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        taskId: 'old',
        materialIds: ['m1', 'm2']
      })
    );
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText('Added 2 to “Catalog Pro Caps”')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the task' })).toBeTruthy();
    // Nothing moved: you are still where you were working.
    expect(window.location.pathname + window.location.search).toBe(
      '/team/space/explorer?folder=f1'
    );
  });

  it('says a file already there is already there', async () => {
    const user = userEvent.setup();
    open(
      client({
        attachTaskMaterials: vi.fn(async () => ({
          attached: [],
          alreadyAttached: ['m1', 'm2'],
          rejected: []
        }))
      })
    );
    await user.click((await screen.findAllByRole('option'))[0]!);
    expect(await screen.findByText('Already on “Transcribe TR 05/09”')).toBeTruthy();
  });
});
