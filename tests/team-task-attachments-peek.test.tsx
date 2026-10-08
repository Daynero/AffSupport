// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamTaskAttachmentSummary } from '@video-compressor/shared';
import { TaskAttachmentsPeek } from '../apps/web/src/team/tasks/TaskAttachmentsPeek';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';
import { announceTaskAttachmentsChanged } from '../apps/web/src/team/tasks/taskAttachmentEvents';

const api = vi.hoisted(() => ({
  getTask: vi.fn(),
  mintThumbnailSession: vi.fn(),
  thumbnailUrl: vi.fn((_session: unknown, material: string) => `https://thumb.test/${material}`)
}));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: api }));
afterEach(() => {
  clearThumbnailSessions();
  vi.clearAllMocks();
});

function attachment(id: string): TeamTaskAttachmentSummary {
  return {
    id,
    taskId: 'task',
    materialId: id,
    name: `${id}.png`,
    category: 'image',
    availability: 'ready',
    previewState: 'ready',
    position: 0,
    driveVersion: null
  };
}

it('reuses attachment metadata and stable thumbnail URLs on repeat opens and refreshes changed attachments', async () => {
  api.getTask.mockResolvedValue({ attachments: [attachment('one'), attachment('two')] });
  api.mintThumbnailSession.mockResolvedValue({
    token: 'session',
    teamId: 'team',
    endpoint: 'https://thumb.test',
    expiresAt: new Date(Date.now() + 900_000).toISOString()
  });
  render(
    <TaskAttachmentsPeek
      teamId="team"
      taskId="task"
      count={2}
      trigger={<button>Attachments</button>}
    />
  );
  expect(api.getTask).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: 'Attachments' });
  fireEvent.focus(trigger);
  await screen.findByText('one.png');
  const peek = screen.getByRole('dialog');
  expect(peek.className).toContain('team-task-attachments-peek');
  expect(peek.querySelector('ul')?.style.getPropertyValue('--peek-columns')).toBe('2');
  await waitFor(() =>
    expect(peek.querySelector('img')?.getAttribute('src')).toBe('https://thumb.test/one')
  );
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.focus(trigger);
  await screen.findByText('one.png');
  expect(api.getTask).toHaveBeenCalledTimes(1);
  expect(api.mintThumbnailSession).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
    'https://thumb.test/one'
  );
  api.getTask.mockResolvedValue({ attachments: [attachment('replacement')] });
  act(() => announceTaskAttachmentsChanged('task'));
  await screen.findByText('replacement.png');
  expect(screen.queryByText('one.png')).toBeNull();
  expect(api.getTask).toHaveBeenCalledTimes(2);
});
