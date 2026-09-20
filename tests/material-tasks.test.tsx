// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialTasks } from '../apps/web/src/team/materials/MaterialTasks';
import { announceTaskAttachmentsChanged } from '../apps/web/src/team/tasks/taskAttachmentEvents';

/** The tasks a file is on, in its card (024). */

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a file in its tasks', () => {
  it('lists the tasks as ways to them', async () => {
    render(
      <MaterialTasks
        teamId="team-1"
        material={{ id: 'm1', name: 'Gs2_2.mp4' }}
        client={{
          listMaterialTasks: vi
            .fn()
            .mockResolvedValue([{ id: 't1', title: 'Launch GlucoSoft', status: 'in_progress' }])
        }}
      />
    );
    const link = await screen.findByRole('link', { name: /Launch GlucoSoft/ });
    expect(link.getAttribute('href')).toContain('task=t1');
    expect(screen.getByText('In tasks')).toBeTruthy();
  });

  it('says nothing for a file on no task, where nothing can be added', async () => {
    const listMaterialTasks = vi.fn().mockResolvedValue([]);
    const { container } = render(
      <MaterialTasks
        teamId="team-1"
        material={{ id: 'm1', name: 'Gs2_2.mp4' }}
        client={{ listMaterialTasks }}
      />
    );
    await vi.waitFor(() => expect(listMaterialTasks).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('reads again when a file is put on a task from anywhere', async () => {
    const listMaterialTasks = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 't2', title: 'Horses launch', status: 'todo' }]);
    render(
      <MaterialTasks
        teamId="team-1"
        material={{ id: 'm1', name: 'Horses1.png' }}
        client={{ listMaterialTasks }}
      />
    );
    await vi.waitFor(() => expect(listMaterialTasks).toHaveBeenCalledTimes(1));
    announceTaskAttachmentsChanged('t2');
    expect(await screen.findByRole('link', { name: /Horses launch/ })).toBeTruthy();
  });
});
