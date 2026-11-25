// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskAttachmentPicker } from '../apps/web/src/team/tasks/TaskAttachmentPicker';

// Owner, 25.11: typing «TR» found the folder «Туреччина», but opening it left the search up;
// every press stacked the folder onto the trail again and nothing opened, and the next opening
// of the picker began inside «Туреччина / Туреччина / Туреччина…».

afterEach(cleanup);

const turkey = {
  id: '11111111-1111-4111-8111-0000000000f1',
  providerId: 'drive-turkey',
  name: 'TR - Туреччина',
  teamId: 'team',
  kind: 'folder',
  parentFolderId: 'drive-geo'
};
const clip = {
  id: '11111111-1111-4111-8111-000000000001',
  name: 'TR1.mp4',
  teamId: 'team',
  kind: 'file',
  category: 'video',
  parentFolderId: 'drive-turkey'
};

function renderPicker() {
  const client = {
    listMaterials: vi.fn(async (_team: string, parent: string | null) =>
      parent === 'drive-turkey' ? [clip] : [turkey]
    ),
    searchCatalog: vi.fn(async () => ({ items: [turkey], total: 1 }))
  };
  render(
    <TaskAttachmentPicker
      teamId="team"
      client={client as never}
      attachedMaterialIds={new Set()}
      onAdd={vi.fn()}
      trailTo={folder => (folder === 'drive-geo' ? [{ id: 'drive-geo', name: 'Гео' }] : [])}
      trigger={open => (
        <button type="button" onClick={open}>
          Open picker
        </button>
      )}
    />
  );
  return client;
}

it('opens a folder found by name at its own place, and leaves the search', async () => {
  const client = renderPicker();
  fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
  fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'TR' } });
  const found = await screen.findByRole('button', { name: /TR - Туреччина/u }, { timeout: 2000 });
  fireEvent.click(found);
  // The folder's own files, under its real trail — and the search box is empty again.
  expect(await screen.findByRole('button', { name: /TR1\.mp4/u })).toBeTruthy();
  expect(client.listMaterials).toHaveBeenLastCalledWith('team', 'drive-turkey');
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  const trail = document.querySelector('.team-task-picker-path')!.textContent!;
  expect(trail).toContain('Гео');
  expect(trail.match(/Туреччина/gu)).toHaveLength(1);
});

it('starts at the root again the next time it is opened', async () => {
  const client = renderPicker();
  fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
  fireEvent.click(await screen.findByRole('button', { name: /TR - Туреччина/u }));
  await screen.findByRole('button', { name: /TR1\.mp4/u });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('button', { name: /TR1\.mp4/u })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
  await waitFor(() => expect(client.listMaterials).toHaveBeenLastCalledWith('team', null));
});
